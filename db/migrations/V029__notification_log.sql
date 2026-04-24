-- Bildirim gönderim logları
CREATE TABLE IF NOT EXISTS ops.notification_log (
    log_id          BIGSERIAL PRIMARY KEY,
    alert_id        BIGINT REFERENCES ops.alert(alert_id),
    channel_id      INTEGER,
    channel_type    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'sent',  -- sent, failed
    error_message   TEXT,
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_log_alert ON ops.notification_log(alert_id);
CREATE INDEX IF NOT EXISTS idx_notification_log_sent ON ops.notification_log(sent_at);
