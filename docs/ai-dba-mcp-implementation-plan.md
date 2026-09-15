# pgstat AI DBA + MCP Uçtan Uca Uygulama Planı

Tarih: 2026-09-14  
Durum: active  
Kapsam: Bu belge tamamlanana kadar izlenecek ana ürün planıdır.

## 1. Ürün hedefi

Kullanıcı pgstat UI içinde AI ile konuşur. AI araştırma için gereken doğru
soruları ve sınırlı MCP araçlarını seçer; MCP yalnız pgstat API üzerinden,
sınırlandırılmış ve özetlenmiş kanıta erişir. AI'ın pgstat veya izlenen
PostgreSQL veritabanlarına doğrudan erişimi ve genel SQL çalıştırma aracı olmaz.

Bir araştırmada gerekli veri toplanmıyorsa, yetersiz/bayatsa veya veri pgstat'ta
bulunduğu halde uygun API/MCP fonksiyonu yoksa bu durum loglara bırakılmaz.
pgstat'a kalıcı, birleştirilmiş ve insan tarafından yönetilen bir geliştirme
kaydı yazılır. AI hiçbir collector, alarm veya PostgreSQL ayarını otomatik
değiştiremez.

```text
UI konuşması
-> pgstat API / investigation
-> AI DBA worker
-> read-only semantik MCP
-> pgstat API
-> merkezi pgstat DB
-> yapılandırılmış yorum
-> eksik veri/fonksiyon tespiti
-> AI'ın İstedikleri geliştirme listesi
```

## 2. Değişmez sınırlar

- AI'a DB credentials verilmez; doğrudan DB erişimi yoktur.
- `execute_sql`, `query_table` veya benzeri genel araç yoktur.
- MCP'nin okuma araçları semantik, parametreli, zaman/sonuç sınırlı ve
  audit edilebilir olur.
- Tek yazma aracı doğrulanmış telemetry-improvement bildirimi içindir.
- PostgreSQL object adları, query text ve bütün tool çıktıları güvenilmeyen
  veri kabul edilir; talimat olarak yorumlanmaz.
- Gözlenen gerçek, teknik bilgi, çıkarım, hipotez ve bilinmeyen ayrılır.
- Veri yokluğu olay yokluğu; NULL sıfır; korelasyon nedensellik sayılmaz.
- pgstat Core, AI servisi kapalıyken çalışmaya devam eder.
- Yeni collector işi ancak gerçek araştırma eksikliğiyle gerekçelendirilir.

## 3. Mevcut repo gerçeği

- Collector merkezi pgstat DB'ye veri yazıyor.
- Express/TypeScript API merkezi DB'yi okuyor ve korunan yollar JWT istiyor.
- Mevcut auth tek `admin` rolüdür; tenant/RBAC varmış gibi davranılmayacak.
- UI React/Vite tabanlıdır.
- V120–V124 ile investigation, provider, improvement ve evidence kayıtları;
  Express servis yolları, autovacuum evidence API'si, ayrı MCP/worker paketi
  ve AI DBA UI konuşma dilimi kodda bulunmaktadır. Disposable PostgreSQL,
  stdio MCP ve sahte yerel model testleri vardır; canlı sağlayıcı, fleet ve
  üretim uçtan uca kanıtı henüz yoktur. Bunları tamamlandı sayma.
- Mevcut insight/alert sorguları yeniden kullanılabilir, ancak AI'a ham tablo
  olarak açılmaz; semantik API servislerine dönüştürülür.
- pgss capability temeli ve gerçek PostgreSQL matrisi tamamlanmıştır; bütün
  telemetri için genel registry/self-health tamamlanmış değildir.

## 4. Kullanıcı deneyimi

Instance sayfasından veya bağımsız AI DBA sayfasından konuşma başlatılır.
Hazır soru örnekleri bulunur; ilk desteklenen alan autovacuum'dur. Uzun işler
asenkron çalışır ve `queued/planning/collecting/interpreting/completed` ilerleme
durumu, iptal ve timeout gösterilir.

Sonuç görünümü şunları ayırır:

- Sonuç
- Ölçülen kanıt
- AI yorumu
- Güven ve nedeni
- Eksik/bilinmeyen bilgi
- Açılmış geliştirme kaydı

Konuşma görünümü yapılacaktır; fakat sonuç yalnız sohbet metni değildir,
yapılandırılmış kartlar olarak da gösterilir. Araştırma geçmişi kalıcıdır.

## 5. AI sağlayıcı bağlantısı ve ücretsiz hesaplar

2026-09-14 tarihinde resmi sağlayıcı belgeleriyle doğrulanan karar:

- ChatGPT Free/Plus/Pro aboneliği OpenAI API kredisi değildir; API ayrı
  faturalandırılır. ChatGPT web hesabını üçüncü taraf pgstat kullanımı için API
  hesabıymış gibi bağlamayacağız.
- Claude.ai ücretli aboneliği de Anthropic Console/API kullanımını içermez;
  Claude web aboneliğini API erişimi gibi göstermeyeceğiz.
- Gemini API yeni hesaplarda belirli modeller için gerçek bir free tier sunar;
  kullanıcı kendi Gemini API/auth key'ini bağlayabilir.
- OpenRouter `:free` modelleri ve `openrouter/free` yönlendiricisi düşük ve
  değişken limitlerle ücretsiz API kullanımı sunar; geliştirme/düşük hacim için
  bağlanabilir, üretim güvencesi olarak sunulmaz.
- Ollama OpenAI-uyumlu chat/responses ve tool calling sunar; kullanıcının kendi
  donanımında ücretsiz ve veriyi dışarı göndermeyen V1 seçeneğidir.

Bu nedenle V1 bağlantı sırası:

1. **Gemini BYOK** — ücretsiz bulut başlangıç seçeneği.
2. **OpenRouter BYOK** — ücretsiz modeller ve çoklu model seçimi; düşük limit ve
   kullanılabilirlik UI'da açıkça gösterilir.
3. **Ollama / OpenAI-compatible local endpoint** — ücretsiz ve yerel seçenek.
4. **OpenAI API BYOK** — ChatGPT aboneliğinden ayrı API anahtarı/faturalama.
5. **Anthropic API BYOK** — Claude aboneliğinden ayrı Console/API anahtarı.

Sağlayıcı web hesabı OAuth'u ancak sağlayıcı üçüncü taraf uygulamalara resmi,
uygun yetkili API erişimi sunduğunda eklenir. Tüketici web oturumunu, cookie'yi
veya desteklenmeyen OAuth akışını kullanmayacağız.

BYOK anahtarı şifreli secret olarak tutulur; UI/log/audit/model çıktısında
gösterilmez. Ücretsiz bulut katmanlarında içerik sağlayıcı ürünlerini geliştirmek
için kullanılabildiğinden ham query text ve hassas telemetry varsayılan olarak
gönderilmez; kullanıcıya veri politikası gösterilir. Ürün tarafından finanse
edilen ücretsiz kota V1'e dahil değildir; maliyet ve kötüye kullanım modeli
ölçülmeden eklenmez.

Provider bağımsız dar arayüz: plan oluştur, tool sonucuyla devam et, şemalı son
cevap üret. Provider/model, token ve süre her investigation'da kaydedilir.
MCP ve evidence sözleşmeleri sağlayıcıya özel olmaz.

## 6. Kalıcı veri modeli

Yeni `agent` şeması mevcut migration/team kurallarına göre değerlendirilecektir.
Minimum kayıtlar:

- `investigation`: soru, hedef, zaman penceresi, durum, provider/model,
  başlangıç/bitiş/hata.
- `investigation_message`: kullanıcı/assistant mesajları; hassas içerik
  politikası uygulanır.
- `investigation_tool_call`: araç/sürüm, sanitize parametre, süre, durum,
  sonuç boyutu, coverage ve hata.
- `investigation_result`: conclusion, facts, interpretation, hypotheses,
  confidence, limitations ve schema version.
- `telemetry_improvement`: birleştirilmiş ürün eksiği, kısa kullanıcı metni,
  durum, ilk/son görülme ve sayaçlar.
- `telemetry_improvement_occurrence`: investigation, instance, istenen, var
  olan, eksik olan, neden ve teknik coverage kanıtı.

Improvement ana türleri UI için basit kalır:

- `DATA_NOT_COLLECTED`
- `DATA_INSUFFICIENT`
- `MCP_FUNCTION_MISSING`

Teknik alt nedenler (stale, too_few_samples, retention_short,
unknown_capability, unsupported_version, collection_failed, api_failed) detayda
tutulur. Aynı ürün eksiği instance başına çoğaltılmaz; tür + capability +
araştırma türü + gerekliyse PG ailesiyle birleştirilir.

Yaşam döngüsü: `review_required -> accepted -> in_progress -> resolved` veya
`rejected`. Çözüm, aynı araştırma senaryosuyla yeniden doğrulanmadan kapatılmaz.

## 7. MCP V1 araçları — autovacuum dikey dilimi

Araçların kesin request/response şeması mevcut API ve DB sorguları ölçüldükten
sonra sabitlenecektir. İlk gerekli semantik araçlar:

1. `find_instance`
2. `get_telemetry_coverage`
3. `get_autovacuum_overview`
4. `find_tables_needing_vacuum_attention`
5. `get_table_vacuum_evidence`
6. `get_query_performance_evidence`
7. `compare_periods`
8. `report_missing_capability`

Her okuma cevabı ortak zarf döndürür: `status`, `data`, `coverage`,
`limitations`, `gap_candidates`. Durumlar en az `ok`, `partial`, `no_data`,
`not_collected`, `unsupported_version`, `unknown_capability`, `stale`,
`insufficient_samples`, `tool_not_available`, `failed` ayrımını korur.

`report_missing_capability` serbest görev açmaz. API investigation/tool geçmişini
doğrular, hassas içeriği reddeder ve aynı eksikliği birleştirir.

## 8. Eksiklik yakalama

İki kaynak birlikte kullanılır:

- API/MCP deterministik olarak not-collected, stale, sample/gap, retention,
  capability ve collection failure durumlarını üretir.
- AI, verinin mevcut olmasına rağmen gereken semantik fonksiyonun olmadığını
  bildirebilir.

Geçici provider/API timeout'u, yanlış kullanıcı girdisi, yetkisizlik, modelin
yanlış parametresi veya gerçekten gerçekleşmemiş bir olay improvement değildir;
investigation failure/audit kaydıdır.

Ana UI metni kısa olur:

```text
AI ne istedi?
Ne vardı?
Ne eksikti?
Neden veremedik?
Kaç araştırmada görüldü?
```

Teknik örnek sayıları ve capability ayrıntısı açılır detayda kalır.

## 9. AI araştırma döngüsü

1. Soruyu ve hedefi doğrula.
2. Desteklenen araştırma türüne sınıflandır.
3. Gerekli kanıt planını üret.
4. Önce coverage kontrol et.
5. Yalnız gerekli, bounded MCP araçlarını çağır.
6. Yüzde, trend, percentile, sample/gap ve dönem karşılaştırmasını API'de
   deterministik hesapla; LLM'ye hesap yaptırma.
7. Alternatif açıklamaları değerlendir.
8. Eksik kanıtta güveni düşür ve sınırlamayı açıkla.
9. Şema doğrulamalı sonuç üret.
10. Gerçek ürün eksiği varsa improvement bildir.

Tool-call, süre, payload ve token bütçeleri; retry, timeout ve cancellation
zorunludur. Model çıktısı şemaya uymuyorsa kullanıcıya kanıt gibi kaydedilmez.

## 10. Güvenlik ve yetki

- MCP ayrı servis kimliğiyle API'ye bağlanır; token investigation, instance,
  zaman penceresi ve izinli araçlarla sınırlandırılır.
- Mevcut tek-admin auth V1 gerçeğidir; gelecekte tenant/RBAC eklenebilir.
- Query text varsayılan olarak modele gönderilmez; gerektiğinde truncation,
  redaction ve açık sensitivity politikası uygulanır.
- Secret ve credentials hiçbir evidence, prompt, audit veya improvement
  kaydına girmez.
- Yazma, remediation, alarm/collector/config değişikliği ve production SQL
  yürütme yoktur.
- Her investigation ve tool çağrısı audit edilir; tool çıktısı DATA'dır.

## 11. Uygulama sırası

### M0 — Sözleşme ve güncel sağlayıcı kararı

- Autovacuum soru kapsamı ve desteklenmeyen sorular.
- MCP request/response ve structured AI output şemaları.
- Privacy/query-text/redaction kararı.
- Sağlayıcı ölçümü tamamlandı; Gemini/OpenRouter/Ollama ücretsiz yolları ile
  OpenAI/Anthropic ayrı API BYOK yolları yukarıdaki sırada uygulanacak.
- Tool, token, zaman ve payload limitleri.

### M1 — Investigation + improvement temeli

- Migration, repository/service ve API.
- Asenkron DB tabanlı basit kuyruk; Redis/Kafka eklenmez.
- Deduplication/occurrence/audit.
- UI'da araştırma geçmişi ve boş `AI'ın İstedikleri` ekranı.

### M2 — Semantik autovacuum evidence API

- Coverage, overview, aday tablolar, tablo kanıtı, query-performance ve period
  comparison endpoint/service'leri.
- Bütün cevaplarda coverage/limitations/gap candidates.
- Bounded/indexli sorgular ve query-plan ölçümü.

### M3 — MCP server

- Yalnız API client ve semantik araçlar.
- Service auth, investigation kapsamı, audit, timeout/result limit.
- MCP içinde DB/business-logic kopyası yok.

### M4 — AI DBA worker

- Provider bağlantısı, plan/tool döngüsü ve structured output.
- Insufficient evidence ve prompt-injection savunması.
- Otomatik/dogrulanmış improvement bildirimi.

### M5 — UI konuşma ve bağlantı deneyimi

- AI DBA konuşma ekranı, hazır sorular, progress/cancel.
- Provider/model bağlantı ayarları ve güvenli secret yönetimi.
- Sonuç/kanıt/güven/eksik bilgi kartları.
- Improvement kaydına bağlantı.

### M6 — Test ve evaluation

- Yeterli/yok/az/bayat/retention/unsupported/unknown veri.
- Eksik MCP fonksiyonu ve deduplication.
- Geçici hata improvement açmıyor.
- Prompt injection, hallucination, yetki, redaction, tool/token limitleri.
- API contract, MCP contract, AI golden scenario ve UI kritik akış testleri.

### M7 — Kontrollü canlı pilot

- 1–3 instance ve tek autovacuum soru ailesi.
- Tool çağrıları, DB yükü, sonuç doğruluğu ve improvement kalitesi ölçülür.
- İnsan incelemesiyle hatalar kapatılır; sonra yeni DBA alanlarına genişlenir.

## 12. İlk dikey dilimin kabul ölçütü

“Son 24 saatte bu instance'ta autovacuum problemi var mı?” sorusu UI'dan
sorulur; kalıcı investigation açılır; AI bounded MCP araçlarıyla yalnız pgstat
API kanıtını kullanır; sonucu, kanıtı, güveni ve sınırlamayı gösterir. Gerekli
veri collector'da yoksa veya uygun MCP fonksiyonu yoksa aynı ürün eksiği yeni
kart çoğaltmadan `AI'ın İstedikleri` ekranında kısa ve anlaşılır biçimde görünür.

AI kapalıyken pgstat çalışmalı; araştırma production sistemini değiştirmemeli;
testler ve canlı pilot kanıtı olmadan bu dilim tamamlandı sayılmamalıdır.

## 13. Bu plana dahil olup uygulama öncesinde kesinleştirilecek kararlar

- Secret'ların mevcut deployment'ta nasıl şifreleneceği.
- AI worker/MCP'nin aynı deployment içinde ayrı process mi, ayrı container mı
  olacağı.
- İlk tool/token/time/payload limitlerinin ölçülmüş değerleri.
- Query text'in hangi koşulda modele açılacağı.

Bu kararlar kapsam eksikliği değildir; doğrulanmadan varsayılmayacak açık karar
noktalarıdır.
