-- V048: Workload classification eşik default'larını yumuşat.
-- Önceki değerler çok katıydı — analytic ve bulk skoru hiç tetiklenmiyordu,
-- her DB %100 OLTP gözüküyordu. Yeni gradient skor formülüyle birlikte
-- eşikleri "tipik referans" olarak ayarlıyoruz.

update control.workload_classification_config
   set analytic_min_avg_ms  = 200,    -- 500 → 200 (200ms üzeri analitik referans)
       analytic_min_rows    = 1000,   -- 5000 → 1000 (1000 row/call üzeri analitik)
       bulk_min_rows_write  = 10000,  -- 50000 → 10000 (10k row/call üzeri bulk)
       oltp_min_tps         = 0.5,    -- 1.0 → 0.5 (yumuşak — küçük DB'lerde tps düşük)
       mixed_max_dominant   = 60      -- 50 → 60 (mixed sınıfı daha rahat tetiklensin)
 where config_id = 1;
