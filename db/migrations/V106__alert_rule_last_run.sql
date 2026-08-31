-- V106: kural bazli son calisma zamani, kuralin KENDI satirinda
--
-- V105'in aralik kontrolu control.alert_rule_last_eval'e bakiyordu. O tablo
-- (rule_id, instance_pk) anahtarli ve yalnizca bir evaluator metodu
-- updateLastEval'i cagirdiginda dolar. table_space_bloat cagirmiyordu: satir
-- hic olusmadi, aralik kontrolu bir sey bulamadi ve kural 6 saatte bir yerine
-- HER CYCLE calismaya devam etti — yani duzeltmeye calistigi sorunun aynisi
-- yeni kuralda surdu (uretimde tespit, 2026-08-31).
--
-- Kok sebep mekanizmanin kirilganligi: aralik, her evaluator'in ayri bir
-- yerde bookkeeping yapmayi hatirlamasina bagliydi. Yeni bir evaluation_type
-- eklenince ayni hata tekrarlanirdi.
--
-- Cozum: son calisma zamanini kuralin kendi satirinda tut ve evaluate()
-- dongusunde, evaluateRule() dondukten hemen sonra merkezi olarak yaz. Boylece
-- hicbir evaluator unutamaz.

alter table control.alert_rule
  add column if not exists last_run_at timestamptz null;

comment on column control.alert_rule.last_run_at is
  'Bu kuralin en son degerlendirildigi an. evaluation_interval_minutes kontrolu bunu okur. control.alert_rule_last_eval''den farki: o tablo instance bazli ve yalnizca ilgili evaluator yazarsa dolar; bu kolon evaluate() dongusunde merkezi olarak yazilir, yani hicbir evaluator atlayamaz (V106, PGSTAT-P0-043).';
