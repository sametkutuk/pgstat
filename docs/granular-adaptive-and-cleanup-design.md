# Tasarım: Granular Adaptive + Job Run Cleanup + Grafana Time Range

## Özet

3 bağımsız task, tek commit ile deploy edilecek.

| # | Task | Problem | Çözüm |
|---|------|---------|-------|
| 1 | Job run cleanup | ops.job_run günde ~280K satır birikiyor, tablo şişiyor | PurgeEvaluator'a günlük cleanup, 30g üstü sil |
| 2 | Adaptive granular | evaluateAdaptive instance-level, hangi sorgu anormal belli değil | Per-record baseline anomaly detection |
| 3 | Grafana time range | pgstat UI → Grafana geçişinde time range kaybolur | URL query param'dan from/to iframe'e geçir |

---

## Task 1 — ops.job_run Cleanup

### Veri Modeli

```sql
-- V036: db/migrations/V036__job_run_retention.sql
alter table control.retention_policy
  add column if not exists job_run_retention_days integer not null default 30;
```

### Kod Değişiklikleri

| Dosya | Değişiklik |
|-------|-----------|
| `collector/.../service/PurgeEvaluator.java` | `purgeJobRunHistory()` metodu ekle |
| `collector/.../scheduler/JobOrchestrator.java` | UTC 02:00'de `purgeJobRunHistory()` çağır |

### Mantık

1. `ops.job_run_instance` FK bağımlılığı var → önce child sil
2. `ops.job_run` where `started_at < now() - 30 days` sil
3. Günde 1 kez (UTC 02:00), rollup job'u içinde

### Risk

- FK violation: child önce silinir, sorun yok
- Büyük DELETE: 30 günlük ilk çalışmada ~8M satır silinebilir → batch'le (10K'lık chunk)
- Mevcut davranış: değişmez, sadece eski veri temizlenir

---

## Task 2 — Adaptive Evaluator Granular

### Mevcut Durum

`evaluateAdaptive()` → instance toplamı üzerinden baseline karşılaştırma → "instance anormal" diyor ama hangi sorgu/tablo sorumluysa söylemiyor.

### Yeni Akış

```
evaluateAdaptive(rule)
  ├── isGranularMetricType? → evaluateAdaptivePerRecord(rule)
  │     ├── findAnomalousRecords(instancePk, metricType, ...)
  │     │     └── SQL: current_window JOIN historical (4 hafta, aynı saat)
  │     │         → current_val > avg + k*stddev olanları döndür
  │     ├── anomalies boş → resolve (autoResolve ise)
  │     └── anomalies var → alert (top record detayıyla)
  └── değilse → mevcut instance-level kod (aynen kalır)
```

### SQL Tasarımı (statement_metric örneği)

```sql
with current_window as (
  -- Son N dk'daki her queryid'in toplam değeri
  select ss.queryid, ss.dbid, ss.userid,
         sum(d.calls_delta)::numeric as current_val,
         left(qt.query_text, 300) as query_text,
         dbr.datname, rr.rolname
  from fact.pgss_delta d
  join dim.statement_series ss on ...
  where d.instance_pk = ? and d.sample_ts > now() - ?::interval
  group by ...
), historical as (
  -- Son 4 haftada aynı saat dilimindeki her queryid'in avg + stddev
  select queryid, dbid, userid,
         avg(window_sum) as baseline_avg,
         coalesce(stddev_samp(window_sum), 0) as baseline_stddev
  from (
    select queryid, dbid, userid,
           date_trunc('hour', sample_ts) as hour_bucket,
           sum(calls_delta)::numeric as window_sum
    from fact.pgss_delta d
    join dim.statement_series ss on ...
    where instance_pk = ?
      and sample_ts > now() - interval '28 days'
      and sample_ts <= now() - ?::interval  -- mevcut pencereyi hariç tut
      and extract(hour from sample_ts) = ?  -- aynı saat
    group by queryid, dbid, userid, hour_bucket
  ) t
  group by queryid, dbid, userid
)
select c.*, h.baseline_avg, h.baseline_stddev,
       h.baseline_avg + ? * h.baseline_stddev as upper_warning,
       h.baseline_avg + 1.5 * ? * h.baseline_stddev as upper_critical
from current_window c
left join historical h on h.queryid = c.queryid and h.dbid = c.dbid and h.userid = c.userid
where h.baseline_avg is not null
  and c.current_val > h.baseline_avg + ? * h.baseline_stddev
order by (c.current_val - h.baseline_avg) / nullif(h.baseline_stddev, 0) desc
limit 10
```

### Kod Değişiklikleri

| Dosya | Değişiklik |
|-------|-----------|
| `AlertRuleEvaluator.java` | `evaluateAdaptive` başına granular fork |
| `AlertRuleEvaluator.java` | Yeni `evaluateAdaptivePerRecord()` metodu |
| `AlertRuleEvaluator.java` | Yeni `findAnomalousRecords()` SQL helper |
| `AlertRuleEvaluator.java` | Yeni `buildPerRecordAdaptiveMessage()` helper |

### Risk

- **Davranış değişikliği**: Mevcut adaptive kuralları (statement_metric/table_metric) artık per-record tetikleyecek. Instance toplamı anormal ama tek record anormal değilse alert tetiklenmeyebilir.
- **Performans**: 4 haftalık SQL ağır olabilir. Partition pruning çalışır (pgss_delta daily partition). İlk çalışmada yavaş olabilir.
- **Baseline yoksa**: Yeni queryid'ler için historical NULL → bypass (alert tetiklenmez). Bu güvenli.
- **Geriye uyumluluk**: Mevcut alert kuralları aynı rule_id ile çalışmaya devam eder, sadece mesaj formatı ve tetikleme granülaritesi değişir.

---

## Task 3 — Grafana Time Range Geçirme

### Mevcut Durum

`GrafanaEmbed.tsx` → iframe URL: `/grafana/d/{uid}/?orgId=1&theme=light`
Time range ve variable bilgisi geçmiyor.

### Yeni Akış

```
pgstat UI link: /grafana/pgstat-instance-detail?from=now-24h&to=now&var-instance=3
  → GrafanaEmbed.tsx useSearchParams() ile from/to/var-* okur
  → iframe URL: /grafana/d/pgstat-instance-detail/?orgId=1&theme=light&from=now-24h&to=now&var-instance=3
  → Grafana time picker pre-filled açılır
```

### Kod Değişiklikleri

| Dosya | Değişiklik |
|-------|-----------|
| `ui/src/pages/GrafanaEmbed.tsx` | `useSearchParams` ile from/to/var-* oku, iframe URL'sine ekle |

### Risk

- Minimal. Sadece URL parametresi ekleniyor, mevcut davranış bozulmaz.
- from/to yoksa Grafana default'u kullanır (değişiklik yok).

---

## Doğrulama Checklist

- [ ] `cd collector && mvn clean compile -DskipTests` → BUILD SUCCESS
- [ ] `cd api && npx tsc --noEmit` → EXIT 0
- [ ] `cd ui && npx tsc --noEmit` → EXIT 0
- [ ] V036 migration idempotent (ikinci kez hata vermez)
- [ ] Mevcut adaptive kuralları (statement_metric) per-record tetikliyor
- [ ] Job run cleanup UTC 02:00'de çalışıyor (log mesajı)
- [ ] GrafanaEmbed from/to parametresi iframe'e geçiyor
