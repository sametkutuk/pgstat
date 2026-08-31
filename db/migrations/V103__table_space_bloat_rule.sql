-- V103: fiziksel tablo sismesi alarmi
--
-- Mevcut dead_tuple_ratio kurali OLU SATIR sayar. Bu, "autovacuum
-- yetisemiyor" durumunu yakalar ama "autovacuum yetisiyor, olu satirlari
-- temizliyor, ama bosalan alan yeniden kullanilmiyor" durumunu YAPISAL OLARAK
-- goremez — cunku o durumda olu satir sayisi zaten dusuktur.
--
-- Uretim vakasi (2026-08-31, agg.pg_table_stat_hourly_202608): tablo %98'i bos
-- alan olacak sekilde 2432 MB'a sismisti. dead_tuple_ratio ancak %20.00 ile,
-- yani esigin tam sinirinda tetiklendi ve daha kotusu YANLIS aksiyon onerdi:
-- "VACUUM ANALYZE calistir". O komut bu alani geri getirmez; sadece tabloyu
-- yeniden yazan bir islem (VACUUM FULL / pg_repack) getirir. Kullanici
-- onerilen komutu calistirsaydi hicbir sey degismezdi.
--
-- Sebep: rollup her ~5 dakikada bir o saatin bucket'larini yeniden hesaplayip
-- UPSERT ediyor (121.162 satira 1.126.780 update, satir basina ~9 kez). Her
-- UPDATE eski tuple'i olu birakiyor; autovacuum onlari temizliyor ama bosalan
-- alan tabloda kaliyor.
--
-- OLCUM, TAHMIN DEGIL
-- -------------------
-- Kural, satir basina bayt degerini tablonun KENDI tarihsel minimumuna
-- kiyaslar. Minimum, o tablonun sikisik halinin gercek bir olcumudur — VACUUM
-- FULL sonrasi, partition ilk olusturuldugunda ya da tablo boskken kendiliginden
-- olusur. Boylece pg_stats.avg_width'e dayali tahmine ve onun "hic ANALYZE
-- edilmemis tabloda %0 bloat" korlugune ihtiyac kalmiyor.
--
-- warning_threshold / critical_threshold: sisme KATI (orn. 3 = tablo olmasi
-- gerekenin 3 kati). bloat_min_rows kolonu burada MB cinsinden mutlak alt
-- siniri tasir — kucuk bir tabloda %300 sisme 3 MB'dir ve onemsizdir; iki
-- kosul birlikte aranir.

alter table control.alert_rule
  drop constraint if exists ck_alert_rule_eval_type;

alter table control.alert_rule
  add constraint ck_alert_rule_eval_type
  check (evaluation_type in (
    'threshold',
    'alltime_high', 'alltime_low',
    'day_over_day', 'week_over_week',
    'spike',
    'flatline',
    'hourly_pattern',
    'adaptive',
    'stale_statistics',
    'table_space_bloat'
  ));

insert into control.alert_rule (
  rule_name, description, metric_type, metric_name, evaluation_type,
  aggregation, condition_operator, warning_threshold, critical_threshold,
  evaluation_window_minutes, cooldown_minutes, auto_resolve, is_enabled,
  bloat_min_rows
)
select
  'Fiziksel Tablo Şişmesi',
  'Tablonun satır başına kapladığı alanı kendi tarihsel minimumuyla karşılaştırır. Ölü satır sayısından bağımsızdır: autovacuum yetişse bile boşalan alan yeniden kullanılmıyorsa bunu yakalar. Uyarı/kritik değerleri ŞİŞME KATIdır (3 = olması gerekenin 3 katı). bloat_min_rows burada MB cinsinden mutlak alt sınırdır.',
  'table_metric', 'space_bloat_ratio', 'table_space_bloat',
  'max', '>', 3, 10,
  1440, 1440, true, true,
  -- Mutlak alt sinir: 100 MB'in altindaki israf gurultudur
  100
where not exists (
  select 1 from control.alert_rule where evaluation_type = 'table_space_bloat'
);

insert into control.alert_message_template (alert_code, title_template, message_template, description)
select 'table_space_bloat',
  '{{severity_emoji}} {{instance}} — {{table}} fiziksel olarak şişmiş ({{bloat_ratio}}x)',
  E'{{table}} olması gerekenin {{bloat_ratio}} katı yer kaplıyor.\n' ||
  E'DB={{database}} · Şu an {{current_size}} · Sıkışık hâli {{compact_size}} · İsraf {{wasted_size}}\n\n' ||
  E'Teşhis: {{diagnosis}}\n' ||
  E'Aksiyon: {{bloat_action}}',
  'Satır başına alan, tablonun kendi tarihsel minimumunun katı olarak. Ölü satır oranından bağımsız fiziksel şişme ölçümü (V103, PGSTAT-P0-042)'
where not exists (
  select 1 from control.alert_message_template where alert_code = 'table_space_bloat'
);
