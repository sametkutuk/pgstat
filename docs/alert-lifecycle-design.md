# Alarm Yaşam Döngüsü — Tasarım (PGSTAT-P0-048)

Durum: r1 · 2026-09-03
Kapsam: `ops.alert` üreten tüm yollar
İlgili: `docs/alert-reference.md`, `docs/platform-governance-and-sdlc.md`, board `PGSTAT-P0-048`

---

## 1. Neden

Müşteri 2026-09-02'de Telegram akışını inceledi ve "yetersiz ve yanlış" dedi. Şikâyetin
arkasında üç ayrı kusur vardı; hepsi kodda doğrulandı. Ama düzeltmeye başlarken ortaya
çıkan asıl mesele şu: **`ops.alert` bir olay tablosu gibi kullanılıyor, ama aslında bir
durum tablosu.** Bir ihlâlin ne zaman başladığını, kaç kez teyit edildiğini, arada
değerlendirilemediği bir aralık olup olmadığını, kullanıcının onayının hangi duruma
verildiğini tutan hiçbir alan yok. Bu yüzden:

- **Kıdem yanlış ölçülüyor.** `stale_hours`, son ANALYZE'dan bu yana geçen süre olarak
  hesaplanıyor; oysa aciliyeti belirleyen, eşiğin ne zaman aşıldığı. 178 saat önce
  analiz edilmiş ama eşiği bir saat önce geçmiş bir tablo 178 saat rapor ediyor ve
  doğrudan CRITICAL'a gidiyor.
- **Onay siliniyor.** Kullanıcı alarmı "gördüm" işaretliyor, bir sonraki değerlendirme
  `acknowledged_at`'i `null` yapıp durumu `open`'a çeviriyor.
- **Tekrar sayısı olay sayısı sanılıyor.** `occurrence_count` her değerlendirmede artıyor
  (şikâyet edilen alarmda 637), gönderilen bildirim ise 9.
- **Sessizlik yorumlanamıyor.** Bir kural bir instance için hiçbir şey üretmediğinde,
  "değerlendirdi, bulgu yok" ile "o instance'a hiç bakılmadı" ayırt edilemiyor. Bu hafta
  üçüncü kez aynı şekilde karşımıza çıktı.

Bunların hiçbiri tek tek yamayla kapanmıyor; hepsi aynı eksik kavramın belirtileri:
**ihlâl epizodu.**

## 2. Kavram

Bir **epizot**, bir ihlâlin kimliği belli tek bir sürekliliğidir. Bir kez açılır,
yeniden değerlendirmelerden sağ çıkar, koşul geçtiğinde kapanır; sonraki ihlâl yeni bir
epizottur.

Epizodun taşıdığı ve `ops.alert`'te bugün olmayan şey **durum**:

| Durum | Anlamı | Kapatır mı? | İhlâl saatini ilerletir mi? |
|---|---|---|---|
| `confirmed_breaching` | Değerlendirildi, koşul **doğru** | Hayır | Evet |
| `confirmed_healthy`   | Değerlendirildi, koşul **yanlış** | **Evet** | Hayır |
| `unknown`             | **Değerlendirilemedi** | **Hayır** | **Hayır** |

`unknown` bu tasarımın merkezinde. Instance'a ulaşılamadığında, sorgu hata verdiğinde
veya kimlik eksik olduğunda mevcut kod hiçbir şey yazmaz — ve veri yokluğu sessizce
"iyileşti" gibi okunur. `unknown` bunu kayda geçirir: epizot açık kalır, ama ihlâl
saati ilerlemez. **Veri yokluğu sağlık kanıtı değildir.**

## 3. Kimlik ve tekillik

Epizot kimliği `alert_key`. Bu, üreticilerin bugün kullandığı doğal kimlik.

**Açık epizot tekilliği `alert_key` üzerinde** — `closed_at is null` olan en fazla bir
satır. Bu, `ops.alert`'in `uq_alert_key` kısıtıyla birebir örtüşür ve gölge karşılaştırma
sorgusunu anlamlı kılar; iki tarafta da açık kayıt sayısı eşit olmalıdır.

### Fiziksel nesil neden anahtarın parçası değil

Dış inceleme `relation_generation`'ın aktif tekillik anahtarına girmesini önerdi. Niyeti
doğru — `VACUUM FULL` sonrası tablo fiziksel olarak başka bir nesnedir, eski nesildeki
şişme ihlâli yenisinde devam eden bir ihlâl değildir — ama anahtara koymak aynı
`alert_key` için iki açık epizodu mümkün kılar ve `ops.alert` ile 1:1 eşlemeyi bozar.
Karşılaştırma sorgusu da o noktada yalan söylemeye başlar.

Bunun yerine nesil **öznitelik** olarak tutulur ve **değiştiğinde eski epizot
`close_reason='identity_changed'` ile kapanıp yenisi açılır.** Niyet korunur, tekillik
bozulmaz.

### Kimlik eksikse

`relation_generation` beklenip de gelmediyse **epizot açılmaz**; bunun yerine
`identity_status='missing_identity'` ile kayıt düşülür. Uydurulmuş kimlikle açılan bir
epizot, sonradan gerçek kimlik geldiğinde çakışır ve iki ihlâli birbirine karıştırır.

## 4. Zaman ve sıra

- `first_observed_breaching_at` — **yalnızca yanlış→doğru geçişinde yazılır**, yeniden
  değerlendirme tarafından asla üzerine yazılmaz. Kıdem severity'si bundan hesaplanır.
- `last_sample_ts` — gözlemin ait olduğu an. **Geç gelen veya tekrarlanan örnek durumu
  ilerletmez:** güncelleme `sample_ts > last_sample_ts` koşuluna bağlıdır. Toplama
  gecikip iki örnek ters sırada işlenirse epizot geri sarmaz.
- `last_confirmed_at` — **seyrek yazılır** (varsayılan 1 saat). Gerekçe V112'de öğrenildi:
  her değerlendirmede yazılan bir damga, üstelik indeksliyse, HOT güncellemeyi imkânsız
  kılıp tabloyu şişirir. `dim.statement_series` bu yüzden 942 MB olmuştu.

## 5. Onay (ACK)

Bugün iki kod yolunun politikası **birbirinin tersi** — bu, tasarım sırasında bulundu:

- `AlertRepository` (üç upsert'in üçü de): `acknowledged` → `open`, `acknowledged_at = null`
  → kullanıcının onayı **siliniyor**
- `AlertService`: `acknowledged` → `acknowledged`, `acknowledged_at` **korunuyor**

Yani sistem alarmlarında onay yaşıyor, kullanıcı kuralı alarmlarında ölüyor. Aynı üründe
iki zıt davranış, ikisi de yazılı bir karar değil — upsert'in yan etkisi.

Tek politika: **onay epizoda verilir ve epizot boyunca yaşar.**

- Onay **silinmez, geçersizleştirilir.** Severity yükselirse `ack_invalidated_at` ve
  `ack_invalidated_reason` yazılır; `acknowledged_at` yerinde kalır. "Kullanıcı bunu
  warning'ken onaylamıştı, sonra critical oldu" cümlesi kurulabilir olmalı.
- Her onay/geçersizleştirme `ops.alert_episode_ack` tablosuna geçmiş kaydı olarak düşer.
- Severity yükselmesinin onayı bozması **açık bir politikadır**, upsert'in yan etkisi
  değil.

## 6. Dört adım

Bu iş tek seferde yapılamaz; `ops.alert` 20'den fazla dosyadan okunuyor, `acknowledged_at`
41 yerde, `occurrence_count` 25 yerde geçiyor.

### Adım 1 — Şema ve gölge yazım *(bu sürümde)*

`ops.alert_episode` + `ops.alert_episode_ack` oluşturulur ve mevcut alarm akışının
**yanında** doldurulur. Alarm, bildirim ve UI davranışı **hiç değişmez**.

Kanca noktası **iki sınıf**: `AlertRepository` ve `AlertService`. Sayım doğrulandı —
`LongRunningQueryEvaluator`, `SlotLifecycleEvaluator` ve `XidFreezeEvaluator`'ın doğrudan
SQL'i yoktur, hepsi `AlertRepository` üzerinden geçer. `AlertRuleEvaluator`'ın yedi
yazması ise alarm açmaz/kapatmaz, açılmış satırın severity'sini yamalar; bunlar
`AlertRepository.patchSeverity` üzerinden merkezileştirilir ki epizodun severity'si kör
kalmasın. Kör bilindiği hâlde kurulan bir gölge, kapı olarak kullanılamaz.

### Adım 2 — `stale_statistics` epizoda taşınır

Tablo başına alarm; severity `first_observed_breaching_at`'ten. Son ANALYZE ayrı bağlam
olarak kalır. Eski instance-anahtarlı alarmları kapatan migration, ve en az bir sürüm
boyunca savunmacı kapatma. ACK'in doğruluk kaynağı epizoda taşınır.

### Adım 3 — Bildirim denetimi

`rendered_title`, `rendered_body`, `payload_hash`, `episode_id` köprüsü, `event_type`,
`status`, `suppression_reason`, `attempt_no`, `provider_message_id`. Bugün
`notification_log` gönderilen metni tutmuyor; müşteri bir mesajı gösterdiğinde onu
üreten koşulu geri bulmanın yolu yok. Geri çekilme (backoff) durumu kendi tablosunda,
`occurrence_count`'ta değil.

### Adım 4 — Kalan aileler

`dead_tuple_ratio`, `table_space_bloat` ve kalan üreticiler ortak yaşam döngüsüne geçer.
Gölge yazım kaldırılır, epizot doğruluk kaynağı olur.

## 7. Adım 1'in gerçek etkisi

Riski sıfıra yakın, **etkisi sıfır değil**: yeni migration, iki sınıfta çağrı, hata
izolasyonu, purge ve testler. Bunu küçümsemek, bu haftanın üç kez tekrarlanan hatasını
dördüncü kez yapmak olurdu.

### Gölge yazım ana akışı durduramaz

Dış inceleme haklı olarak şunu sordu: yakalanan bir istisna yetmez, çünkü epizot yazımı
ana alarm yazımıyla **aynı transaction'daysa** SQL hatası transaction'ı `aborted` duruma
sokar ve ana alarm commit edilemez.

Bu kod tabanında bugün **ortak transaction yok** — doğrulandı:

- collector genelinde `@Transactional` sıfır eşleşme
- `TransactionTemplate` / `PlatformTransactionManager` kullanımı yok
- Hikari'de `auto-commit: false` yok → varsayılan `autoCommit=true`

Yani her `jdbc.update(...)` kendi transaction'ı; epizot INSERT'i patlasa ana alarm
INSERT'inin transaction'ını abort edemez.

**Ama bu garanti kazara, tasarlanmış değil.** Biri yarın `evaluate()` metoduna
`@Transactional` eklerse — ki toplu alarm yazımı için akla yatkın bir hamledir — gölge
yazım sessizce o transaction'a katılır ve incelemenin tarif ettiği senaryo gerçek olur.
Bu yüzden garanti **yazılı bir değişmez** hâline getirilir ve **test edilir**:

> **Değişmez:** Alarm yazma yolunda hiçbir metot bir transaction'a katılmaz.
> `ops.alert` ve `ops.alert_episode` yazımları ayrı autocommit ifadeleridir.

Bunu bozacak bir `@Transactional` eklenirse `AlertPathTransactionGuardTest` kırılır.

Ek olarak gölge yazım:

- kendi `try/catch`'inde çalışır, ana akışın sonucunu **değiştirmez**
- başarısızlıkta **WARN + stack trace** üretir — `DEBUG`'da yutulmaz
- bir **hata sayacı** artırır (`shadowWriteFailures`), son hata zamanı ve mesajıyla
  birlikte okunabilir; sessizce kaybolmaz

Bu, bu haftanın dersinin iki yüzünü birden karşılar: sessiz `catch` işi gizler, ama
gizlenmemiş bir istisna da alarm üretimini kesebilir. İkisi de kabul edilemez.

### Yazma yükü

Bu tablo her değerlendirmede her açık alarm için güncellenir — yani tam olarak V112'de
düzelttiğimiz desen. Baştan HOT dostu kurulur: `fillfactor=85`, sık güncellenen hiçbir
kolonda indeks yok (`last_confirmed_at`, `last_sample_ts`, `observation_count`, `state`),
`last_confirmed_at` seyrek yazılır.

### Saklama

Kapanmış epizotlar `control.retention_policy.alert_retention_days` ile silinir — yeni bir
ayar düğmesi eklenmez. Açık epizotlar silinmez. Purge **aynı sürümde** gelir; sonraya
bırakılan bir temizlik, büyüyen bir tablo demektir.

## 8. Adım 1 kabul kriterleri

1. `ops.alert_episode` ve `ops.alert_episode_ack` oluşturulur; açık epizot tekilliği
   `alert_key` üzerinde kısmi tekil indeksle zorlanır.
2. Üç durum (`confirmed_breaching` / `confirmed_healthy` / `unknown`) yazılır; `unknown`
   epizodu kapatmaz ve ihlâl saatini ilerletmez.
3. `first_observed_breaching_at` yalnızca yanlış→doğru geçişinde yazılır.
4. Sırasız veya tekrarlanan `sample_ts` durumu ilerletmez.
5. `relation_generation` beklenip gelmediyse epizot açılmaz; `missing_identity` kaydedilir.
6. Nesil değişimi eski epizodu `identity_changed` ile kapatır, yenisini açar.
7. `last_confirmed_at` seyrek yazılır; tablo `fillfactor=85` ve sık güncellenen kolonlarda
   indeks yoktur.
8. Kapanmış epizot saklaması `alert_retention_days` ile aynı sürümde gelir.
9. Mevcut alarm, bildirim ve UI davranışı **değişmez**; epizot yalnızca yazılır, okunmaz.
10. Gölge yazım hatası ana alarm akışını durdurmaz — repository fırlatırken alarm yine
    açılır (`AlertEpisodeShadowFailureTest`).
11. Alarm yazma yolunda `@Transactional` bulunmaz (`AlertPathTransactionGuardTest`).
12. Gölge yazım hatası WARN + stack trace üretir ve sayacı artırır.
13. **Çift yönlü karşılaştırma sorgusu** dokümanda yer alır ve deploy sonrası çalıştırılır:
    epizodu olmayan açık alarm **ve** alarmı olmayan açık epizot, ikisi de sıfır olmalıdır.

## 9. Çift yönlü karşılaştırma sorgusu

Deploy kapısı. Tek yönlü bir sorgu ("her alarmın epizodu var mı") eksik yazımı yakalar
ama fazla yazımı kaçırır; epizodun kapanmadığı durumu görmez.

```sql
-- A) Acik alarmi olup epizodu olmayan  (golge yazim eksik)
select 'alarm_var_epizot_yok' as sorun, a.alert_key, a.alert_source, a.first_seen_at as an
  from ops.alert a
  left join ops.alert_episode e
    on e.alert_key = a.alert_key and e.closed_at is null
 where a.status in ('open', 'acknowledged')
   and e.episode_id is null
union all
-- B) Acik epizodu olup acik alarmi olmayan  (epizot kapanmamis)
select 'epizot_var_alarm_yok', e.alert_key, e.alert_source, e.opened_at
  from ops.alert_episode e
  left join ops.alert a
    on a.alert_key = e.alert_key and a.status in ('open', 'acknowledged')
 where e.closed_at is null
   and a.alert_id is null
order by 1, 4;
```

Beklenen: **sıfır satır.** Sıfır değilse gölge yazım güvenilir değildir ve 2. adım
başlatılmaz.

Yardımcı sağlık sorgusu:

```sql
select state, identity_status, count(*), min(opened_at), max(last_confirmed_at)
  from ops.alert_episode
 where closed_at is null
 group by 1, 2 order by 3 desc;
```

## 10. Doğrulama (2026-09-03)

Migration ve durum makinesi, üretime dokunmadan **tek kullanımlık bir PostgreSQL 17
konteynerinde gerçekten koşturularak** doğrulandı — üretimle aynı ana sürüm. Şema kurulur,
V114 uygulanır, repository'nin **gerçek** upsert ifadesi `PREPARE`/`EXECUTE` ile
çalıştırılır. Onbir davranışın hepsi tasarlandığı gibi:

| # | Beklenen | Sonuç |
|---|---|---|
| 1 | İlk ihlâl epizodu açar, ihlâl saatini damgalar | ✓ |
| 2 | Aynı severity + taze damga → satıra dokunulmaz | ✓ `observation_count` 1'de kaldı |
| 3 | Severity değişti → günceller, **ihlâl saati değişmez** | ✓ |
| 4 | Severity düştü → `max_severity` geri gitmez | ✓ `critical` korundu |
| 5 | Sırasız (geçmiş zamanlı) örnek → durum ilerlemez | ✓ `last_sample_ts` geri gitmedi |
| 6 | `unknown` kapatmaz, ihlâl saatini ilerletmez | ✓ |
| 7 | `unknown` → `breaching` geçişinde saat o an damgalanır | ✓ |
| 8 | Kapanış sonrası yeni ihlâl → **yeni** epizot | ✓ 2 epizot, 1 açık |
| 9 | Aynı anahtardan ikinci açık epizot açılamaz | ✓ `uq_alert_episode_active` reddetti |
| 10 | Alarm bizden önce açılmışsa `backfilled` işaretlenir | ✓ 3 gün önceki alarm `t` |
| 11 | `closed_at` sebepsiz yazılamaz | ✓ `ck_alert_episode_closed_has_reason` reddetti |

Çift yönlü karşılaştırma sorgusu ve purge ifadesi de aynı konteynerde çalıştırıldı;
sorgu, sentetik veride kasten bırakılan "epizodu var, alarmı yok" durumunu yakaladı —
yani B yönü çalışıyor, tek yönlü bir sorgunun kaçıracağı hâli görüyor.

Birim testleri 105 → **112**, hepsi geçiyor.

## 11. Bilinen sınırlar

- Adım 1'de epizot **yalnızca yazılır, okunmaz.** Bu bilinçli: gölge dönemi bitmeden
  epizoda dayanan bir karar vermek, doğrulanmamış bir veriye güvenmek olurdu.
- **Adım 1'de fiziksel kimlik dolmuyor.** Kanca noktası repository katmanı ve orası tablo
  kimliğini bilmiyor; `dbid`, `relid`, `relation_generation` `null` geçiliyor ve
  `expectsGeneration` `false`. Bu yüzden AC5/AC6'nın (kimlik eksikse epizot açma, nesil
  değişince kapat) kodu yazıldı ve testleri geçiyor ama **üretimde henüz tetiklenmiyor** —
  tablo bazlı kurallar kimliği taşımaya Adım 2'de başlayacak. Alternatif kimliği
  `alert_key`'i ayrıştırarak tahmin etmekti; yanlış ayrıştırılan bir kimlik iki ayrı
  ihlâli birleştirirdi, o yüzden boş bırakıldı.
- **Kimlik eksikliği kalıcı olarak kaydedilmiyor**, yalnızca WARN + bellek içi sayaç.
  Gölge döneminde yeterli; epizot karar vermeye başladığında (Adım 2) kalıcı kayıt gerekir.
- **Durum makinesi birim testiyle kapalı değil**, çünkü mantık SQL'de ve projede DB test
  altyapısı yok. Yukarıdaki konteyner koşumu bu boşluğu kapatıyor ama **CI'da otomatik
  çalışmıyor** — elle yapılmış bir doğrulama. Kalıcı çözüm entegrasyon test altyapısı,
  ayrı board maddesi.
- `ops.alert_episode` geriye dönük doldurulamaz. Mevcut açık alarmlar epizotlarını ilk
  değerlendirmede alır; `first_observed_breaching_at` o an damgalanır, yani **mevcut
  alarmların kıdemi olduğundan genç görünür.** Alternatif `first_seen_at`'i geriye
  taşımaktı; o da yanlış olurdu çünkü `first_seen_at` alarmın ilk yazıldığı an, ihlâlin
  başladığı an değil. Yanlış bir kıdem uydurmaktansa genç görünmesi tercih edildi ve
  `backfilled` bayrağıyla işaretlenir.
- Gerçek DB transaction davranışını doğrulayan bir entegrasyon testi **yok**, çünkü
  Testcontainers/H2 gibi bir altyapı bu projede hiç yok — 105 testin tamamı saf birim
  testi. Yerine kaynak tarayan bir değişmez testi konuldu (kabul kriteri 11), aynı
  regresyonu Docker bağımlılığı olmadan yakalar. Gerçek entegrasyon test altyapısı ayrı
  bir board maddesi olarak kaydedilir; tek bir özelliğin yan ürünü olarak eklenmemelidir.
