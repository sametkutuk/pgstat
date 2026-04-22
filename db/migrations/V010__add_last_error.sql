-- instance_state tablosuna son hata mesajini tutan kolon ekle
alter table control.instance_state
  add column if not exists last_error text null,
  add column if not exists last_error_at timestamptz null;
