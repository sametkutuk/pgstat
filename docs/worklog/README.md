# pgstat Worklog

Günlük iş özetleri. Her çalışma günü için tek dosya: `YYYY-MM-DD.md`.

Amaç: "o gün ne yapıldı, neden yapıldı, ne karar verildi" sorusunun tek
bakışta cevabı. Commit geçmişi *nasıl* yapıldığını anlatır; worklog *neyin
bittiğini ve nedenini* anlatır.

Kurallar:

- Gün sonunda (veya iş kapanışında) o günün dosyası yazılır/güncellenir.
- Kısa tutulur: yapılanlar, kapanan/açılan board görevleri, verilen kararlar
  (ADR'ye gidenler link olarak), ertesi güne kalanlar.
- Board'ın yerine geçmez: görev durumunun tek kaynağı `docs/project-board.json`.
  Worklog anlatıdır, durum kaydı değildir.
- Dil serbesttir (Türkçe tercih edilir); teknik terimler ve görev ID'leri
  aynen kullanılır.

## Şablon

```markdown
# YYYY-MM-DD

## Yapılanlar
- ...

## Board hareketleri
- PGSTAT-XX-YYY: planned -> done (tek satır özet)

## Kararlar
- ... (ADR gerekiyorsa: ADR-#### linki)

## Yarına kalanlar
- ...
```
