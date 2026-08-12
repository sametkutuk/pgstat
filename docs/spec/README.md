# pgstat — Davranış Spesifikasyon Programı

Bu klasör, pgstat'ı sıfırdan yeniden yazmadan önce mevcut ürünün davranışını
"noktası virgülüne kadar" tanımlayan domain spesifikasyon dokümanlarını
tutar. Kapsam, sıralama ve şablon kararı için bakınız:
[PGSTAT-P1-008](../project-board.json) (board görevi) ve onaylanan plan
(bu oturumda `C:\Users\samet.kutuk\.claude\plans\gentle-bubbling-turing.md`
altında saklandı, kalıcı referans için içeriği bu README'ye taşınmıştır).

## Amaç

Her doküman, o domain'in davranışını yeniden implementasyon için yeterli
detayda tanımlar: veri kaynağı, iş kuralları, saklama/yaşam döngüsü, API
sözleşmesi, UI davranışı, domain-arası arayüzler, kabul kriterleri ve açık
sorular. Şablonun tam yapısı her doküman dosyasının başında tekrarlanır.

## Neden dikey dilim

Domain'ler uçtan-uca davranış dilimleridir (collector → tablo → API → UI
birlikte), yatay katman değil — çünkü davranış ancak uçtan uca anlamlıdır.
İstisna: **Veri Modeli & Retention/Partition** ve **Scheduler/Job
Orchestration**, altyapı oldukları için tek başına domain'dir.

## Sıralı domain listesi (12 domain, 15 doküman)

| # | Domain | Dosya |
| --- | --- | --- |
| 1 | Veri Modeli & Storage Lifecycle | `01-data-model-and-storage-lifecycle.md` |
| 2 | Instance/Cluster Discovery & Registration | `02-instance-discovery-and-registration.md` |
| 3 | Core Cluster Metrics Collection | `03-core-cluster-metrics.md` |
| 4 | Query Statements (pg_stat_statements) | `04-query-statements.md` |
| 5 | Database Object Inventory & Health | `05-database-object-inventory.md` |
| 6 | Nightly Snapshot & Reporting | `06-nightly-snapshot-and-reporting.md` |
| 7 | Scheduler & Job Orchestration | `07-scheduler-and-job-orchestration.md` |
| 8a | Alerting — Statik Kurallar | `08a-alerting-static-rules.md` |
| 8b | Alerting — Adaptive Baseline | `08b-alerting-adaptive-baseline.md` |
| 8c | Alerting — Lifecycle Subscriptions | `08c-alerting-lifecycle-subscriptions.md` |
| 8d | Notifications & Delivery | `08d-notifications-and-delivery.md` |
| 9 | System Health & Self-Monitoring | `09-system-health-and-self-monitoring.md` |
| 10 | Platform: Auth, Preferences, Audit, Instance Groups | `10-platform-auth-and-audit.md` |
| 11 | Grafana Integration | `11-grafana-integration.md` |
| 12 | Insights & Ad-hoc Analysis | `12-insights-and-adhoc-analysis.md` |

**pgdbaagent kapsam dışı** — ayrı dokümante edilmiş (`../pgdbaagent-contracts.md`,
`../agentic-dba-platform-architecture.md`).

## Sıralama gerekçesi

1→2→3 zorunlu ön koşul zinciri (şema → kayıt → temel telemetri). 4-5 aynı
toplama/delta/partition desenini dar dikey dilimlerde tekrar kullanır. 6-7
toplama katmanını tüketen zamanlama/raporlama. 8a-8d en büyük/riskli domain
(`AlertRuleEvaluator` 3564 satır, `adaptiveAlerting.ts` 41 route) — tek
parça spesifiye etmek "okyanusu kaynatmak" olur, 4 alt-fazda ilerlenir. 9-12
ya kendi kendine referans (sistem sağlığı), ya genel/CRUD (platform), ya
salt-okunur/export (Grafana), ya da türetilmiş/keşifsel (Insights — her
şeyi tükettiği için sona kalır).

## Bilinen belirsizlikler

- `Insights.tsx` (4385 satır) / `insights.ts` (2948 satır) çok-domainli —
  domain #5 ve #12 arasında sekme/özellik bazlı bölünecek.
- `instances.ts` (3216 satır, 69 route) domain #2/#3/#9'a yayılıyor — her
  sahibi domain'e geldiğinde route-route spesifiye edilecek.
- Migration numaralarında çift/dallanma kalıntısı var (V021, V054-057,
  V084) — kanonikmiş gibi sessizce yazılmayacak, her ilgili dokümanda not
  düşülecek.

## İş akışı

1. Domain'in kod tabanı taranır.
2. Şablona göre doküman `docs/spec/<no>-<isim>.md` altına yazılır.
3. Kullanıcı incelemesi ve onayı beklenir.
4. Onay sonrası worklog'a işlenir, sıradaki domaine geçilir.
