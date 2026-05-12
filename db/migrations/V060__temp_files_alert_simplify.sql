-- V060: Temp files alert mesajı sadeleştirildi
-- Önceki: work_mem önerisi + matematik formülü (kullanıcıya çok teknik)
-- Yeni: hangi sorgu, çağrı başına ne kadar diske yazıyor — aksiyon-odaklı

update control.alert_message_template
set message_template =
  E'⚠️ {{database}} veritabanında {{temp_files}} kez geçici dosya oluşturuldu (toplam {{temp_bytes_human}}).\n' ||
  E'Mevcut work_mem={{work_mem}}, sorgular bu sınırı aşıp diske yazıyor.\n\n' ||
  E'{{top_temp_queries}}\n\n' ||
  E'💡 Çözüm: ilgili sorguda EXPLAIN (ANALYZE, BUFFERS) çalıştırın, sort/hash node''larda disk var mı bakın. Sorgu seviyesinde SET LOCAL work_mem=... veya index/limit/select kolon azaltma ile düzeltin. Global work_mem artırma son çare — her connection × her sort/hash için ayrı tüketilir.',
    description = 'Temp file high — sorgu bazlı diske yazma görünür',
    updated_at = now()
where alert_code = 'high_temp_files';
