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
| `index_unused` | Index tam gozlem penceresinde hic scan edilmezse | Min index boyutu MB | 100 MB | Son 30 gun tam gozlem, cluster-aware | Index kullanilirsa veya drop edilirse resolve/manuel |
| `high_temp_files` | DB temp file sayisi esigi asarsa | Temp file sayisi/saat | 100/saat | Son 1 saat database delta | Temp file normale donunce resolve/manuel |
| `idle_in_tx_time_high` | Idle-in-transaction sure orani esigi asarsa | Idle/session yuzdesi | 30% | Son 1 saat database delta, PG14+ | Oran normale donunce resolve/manuel |
| `replication_slot_inactive` | Slot 1 saat inactive kalip WAL tutarsa | Slot lag MB | 1024 MB | Son 1 saat slot snapshot | Slot active olur/drop edilirse resolve/manuel |
| `job_partial_failure` | Job run'da bazi instance'lar fail olursa | Failed/total sayisi | Esik yok | Job orchestrator | Sonraki basarili job/manuel |
| `job_failed` | Job tamamen fail olursa veya genel job exception olursa | Job error | Esik yok | Job orchestrator | Sonraki basarili job/manuel |
| `advisory_lock_skip` | Ayni job icin advisory lock alinamazsa | Lock skip olayi | Esik yok | Job orchestrator | Sonraki job akisi/manuel |

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

`high_temp_files` alerti global `ALTER SYSTEM SET work_mem` onermez. Guvenli
yaklasim once query/session seviyesinde `SET LOCAL work_mem` ile test etmektir.
Global deger icin host RAM, `shared_buffers`, `max_connections` ve eszamanli
sort/hash sayisi bilinmelidir.
