-- V063: parameter_changed alert kodu icin eksik mesaj sablonu
-- AlertCode enum'da var ama V030 seed'inde unutulmustu.

insert into control.alert_message_template
    (alert_code, title_template, message_template, description, is_system)
values (
    'parameter_changed',
    '[INFO] {{instance}} - Parametre degisti: {{parameter_name}}',
    E'ℹ️ **{{instance}}** uzerinde PostgreSQL parametresi degisti.\n' ||
    E'📌 Parametre: **{{parameter_name}}**\n' ||
    E'🔧 Eski deger: `{{old_value}}`\n' ||
    E'✨ Yeni deger: `{{new_value}}`\n' ||
    E'⏰ Tespit edildi: {{detected_at}}\n' ||
    E'\n' ||
    E'💡 Etki: Bu parametrenin degisikligi instance davranisini etkileyebilir. ' ||
    E'Eski/yeni degerleri karsilastirip beklenen bir degisiklik mi kontrol edin.',
    'PostgreSQL parametresi (ALTER SYSTEM/postgresql.conf) degisikligi tespit edildi',
    true
)
on conflict (alert_code) do nothing;
