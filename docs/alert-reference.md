# Alert Reference

Bu tablo built-in alertlerin nasil calistigini ozetler. Degistirilebilir esikler
`control.system_alert_config.threshold_value` alanindan okunur; instance override
varsa global degerin onune gecer.

| Alert code | Ne zaman calisir | Ana parametre/esik | Varsayilan | Kaynak/pencere | Resolve |
| --- | --- | --- | --- | --- | --- |
| `connection_failure` | Source PostgreSQL'e baglanti kurulamazsa | Baglanti hatasi | Esik yok | Collector connection attempt | Baglanti duzelince manuel/sonraki akista resolve |
| `authentication_failure` | Kimlik dogrulama/parola hatasi olursa | Auth hatasi | Esik yok | Collector connection/bootstrap | Auth duzelince manuel/sonraki akista resolve |
| `permission_denied` | Monitoring icin gereken yetki yoksa | Yetki hatasi | Esik yok | Bootstrap/discovery | Yetki duzelince manuel/sonraki akista resolve |
| `extension_missing` | `pg_stat_statements` bulunamazsa | Extension var/yok | Esik yok | Bootstrap/discovery | Extension kurulup bootstrap basarili olunca resolve |
| `secret_ref_error` | `secret_ref` dosya/env cozumlenemezse | Secret cozumleme hatasi | Esik yok | Bootstrap | Secret duzelince retry ile resolve |
| `bootstrap_failed` | Bootstrap adimlarindan biri hata alirsa | `phase`, `error_message` | Esik yok | Bootstrap | Bootstrap basarili olunca resolve/manuel |
| `stale_data` | Hazir instance'ta metrik uzun sure gelmezse | Son cluster collect yasi | 10 dakika kod ici | `control.instance_state` | Veri tekrar gelince auto-resolve akisi |
| `stats_reset_detected` | `pg_stat_statements` reset/epoch degisimi yakalanirsa | Epoch/reset farki | Esik yok | Statements collector | Bilgi alerti; yeni baseline baslar |
| `lock_contention` | Bir lock beklemesi esikten uzun surerse | Bekleme suresi, saniye | 300 sn | Son lock snapshot | Lock bekleme bitince sonraki akista resolve/manuel |
| `high_connection_usage` | `numbackends / max_connections` esigi asarsa | Kullanim yuzdesi | 80% | Son 5 dk icindeki son DB snapshot | Oran normale donunce resolve/manuel |
| `long_running_query` | Aktif client backend query esikten uzun surerse | Query suresi, saniye | 300 sn | Her instance icin son activity snapshot | Query bitince resolve/manuel |
| `replication_lag` | Primary'de replay lag byte esigi asarsa | Lag MB | 50 MB warning, critical=10x | Replication snapshot | Lag normale donunce resolve/manuel |
| `high_bloat_ratio` | Tablo dead tuple orani esigi asarsa | Dead tuple yuzdesi | 20% | Son table stat snapshot | Oran normale donunce resolve/manuel |
| `index_suspect_missing` | Seq scan/idx scan orani yuksek ve tablo anlamli buyukse | Seq/idx oran | 100x | Son 24 saat table delta + relation size | Kosul kalkinca resolve/manuel |
| `index_unused` | Index tam gozlem penceresinde hic scan edilmezse | Esik yok; boyut bilgi amacli | Esik yok | Son 30 gun tam gozlem, cluster-aware | Index kullanilirsa veya drop edilirse resolve/manuel |
| `index_invalid` | Index invalid veya not-ready durumdaysa | Esik yok | Esik yok | Son index stat snapshot | Index valid/ready olunca veya drop edilince resolve/manuel |
| `high_temp_files` | DB temp file sayisi esigi asarsa | Temp file sayisi/saat | 100/saat | Son 1 saat database delta | Temp file normale donunce resolve/manuel |
| `high_temp_files_daily` | DB temp file sayisi gunluk esigi asarsa | Temp file sayisi/24s | 1000/24s | Son 24 saat database delta | Temp file normale donunce resolve/manuel |
| `high_temp_sqls_daily` | 24 saatte cok sayida SQL 100MB+ temp yazarsa | SQL sayisi/24s | 10 SQL | Son 24 saat pg_stat_statements delta | SQL sayisi normale donunce resolve/manuel |
| `idle_in_tx_time_high` | Idle-in-transaction sure orani esigi asarsa | Idle/session yuzdesi | 30% | Son 1 saat database delta, PG14+ | Oran normale donunce resolve/manuel |
| `replication_slot_inactive` | Slot 1 saat inactive kalip WAL tutarsa | Slot lag MB | 1024 MB | Son 1 saat slot snapshot | Slot active olur/drop edilirse resolve/manuel |
| `job_partial_failure` | Job run'da bazi instance'lar fail olursa | Failed/total sayisi | Esik yok | Job orchestrator | Sonraki basarili job/manuel |
| `job_failed` | Job tamamen fail olursa veya genel job exception olursa | Job error | Esik yok | Job orchestrator | Sonraki basarili job/manuel |
| `advisory_lock_skip` | Ayni job icin advisory lock alinamazsa | Lock skip olayi | Esik yok | Job orchestrator | Sonraki job akisi/manuel |
| `system_instance_unreachable` | (a) `consecutive_failures >= 3` olan instance'lar icin `SystemHealthEvaluator` tarafindan periyodik (5 dk); (b) daha once `ready` olan bir instance connect/auth hatasi (ornegin pg_hba.conf yetkisinin kaldirilmasi) yuzunden `degraded`'a dusunce `JobOrchestrator.handleSecretOrAuthError` tarafindan aninda (P0-024, 2026-07-17) | `consecutive_failures` esigi (a) / degrade anlik (b) | 3 basarisizlik (a) | `control.instance_state` (a) / cluster-statements job hatasi (b) | (a) `consecutive_failures` sifirlaninca; (b) instance tekrar `bootstrap_state='ready'`'ye donunce `BootstrapHandler` auto-resolve |

## Custom Rule Template'leri

Bu alertler `ops.alert.alert_code = user_defined_rule` olarak yazilir; text
template secimi metric tipine gore yapilir.

| Template code | Ne zaman kullanilir | Ana parametreler |
| --- | --- | --- |
| `user_defined_rule` | Genel custom rule, granular olmayan metricler | `metric`, `value`, `operator`, `threshold`, `window`, `aggregation` |
| `statement_threshold` | Statement metric threshold rule | `queryid`, `database`, `user`, `current_value`, `threshold`, `window` |
| `statement_spike` | Statement metric spike rule | `previous_value`, `current_value`, `change_pct`, `query_text` |
| `table_threshold` | Table metric threshold rule | `table`, `database`, `metric`, `current_value`, `threshold` |
| `table_spike` | Table metric spike rule | `table`, `previous_value`, `current_value`, `change_pct` |
| `index_threshold` | Index metric threshold rule | `index`, `table`, `metric`, `current_value`, `threshold` |
| `index_spike` | Index metric spike rule | `index`, `table`, `previous_value`, `current_value`, `change_pct` |

## Work Mem Notu

`high_temp_files` query/session seviyesinde `SET LOCAL work_mem` onerisi verir.
Oneri once temp yazan sorgu ihtiyacindan hesaplanir, sonra `max_connections`,
`shared_buffers` ve `effective_cache_size` ile konservatif ust sinira cekilir:
`(effective_cache_size - shared_buffers) / max_connections / 2`.
`effective_cache_size` gercek host RAM degil, PostgreSQL planner cache tahmini/proxy
degeridir; bu nedenle global `ALTER SYSTEM SET work_mem` degisikligi otomatik
onerilmez. `high_temp_sqls_daily` icin SQL basina minimum temp yazimi ilk fazda
sabit 100MB'dir; `threshold_value` sadece kac SQL'den sonra alert uretilecegini
belirler.
