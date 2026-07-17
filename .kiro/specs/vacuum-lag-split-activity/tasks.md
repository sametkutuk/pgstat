# Implementation Plan: Vacuum Lag Split Activity

## Overview

Backend'de 2 fetch fonksiyonundaki SQL'i 4 ayri alana bolmek, frontend'te interface'leri guncellemek, chartData mapping'ini degistirmek ve Bar → 4 Line donusumunu yapmak.

## Tasks

- [x] 1. Backend: fetchVacuumLagTrendData SQL guncelleme
  - `api/src/routes/insights.ts` icinde `fetchVacuumLagTrendData` fonksiyonunu guncelle
  - agg branch (pg_table_stat_hourly): `vacuum_count` yerine 4 ayri sum
  - fact branch (pg_table_stat_delta): `vacuum_count_delta` combined yerine 4 ayri sum
  - Her iki branch'in SELECT ciktisinda `vacuum_count` kaldirilir, 4 yeni alan eklenir
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10_

- [x] 2. Backend: fetchTableVacuumTrend SQL guncelleme
  - `api/src/routes/insights.ts` icinde `fetchTableVacuumTrend` fonksiyonunu guncelle
  - agg branch: `vacuum_count` ve `analyze_count` combined yerine 4 ayri sum
  - fact branch: ayni degisiklik
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 3. Backend tsc dogrulama
  - `api` klasorunde `npx tsc --noEmit` calistir, hata olmamali
  - _Requirements: 1.1, 2.1_

- [x] 4. Frontend: Interface ve chartData guncelleme
  - [x] 4.1 VacuumLagTrendPoint interface guncelle (vacuum_count → 4 alan)
    - _Requirements: 5.1, 5.2_
  - [x] 4.2 TableVacuumTrendPoint interface guncelle (vacuum_count + analyze_count → 4 alan)
    - _Requirements: 5.3, 5.4_
  - [x] 4.3 VacuumLagCardInner chartData mapping guncelle
    - `current_vacuum_count` → `current_vacuum_manual`, `current_vacuum_auto`, `current_analyze_manual`, `current_analyze_auto`
    - `previous_vacuum_count` → `previous_vacuum_total` (sum of 4 previous values)
    - hasTrendData check'ini yeni key'lere gore guncelle
    - _Requirements: 5.5, 3.4_
  - [x] 4.4 TableVacuumTrendPanel chartData mapping guncelle
    - `current_vacuum_count` → 4 ayri key
    - `previous_vacuum_count` → `previous_vacuum_total`
    - _Requirements: 5.6, 4.4_

- [x] 5. Frontend: Ana grafik Bar → 4 Line donusumu
  - VacuumLagCardInner icindeki ComposedChart'ta:
  - Bar component'ini kaldir (current_vacuum_count)
  - 4 Line component ekle (yesil #059669, mor #7C3AED, turuncu #D97706, mavi #2563EB)
  - Compare overlay: previous_vacuum_count Line → previous_vacuum_total tek dashed line
  - strokeWidth: 1.5, dot={false}, connectNulls={true}
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 6. Frontend: ExpandPanel BarChart → LineChart donusumu
  - TableVacuumTrendPanel icindeki 3. grafik:
  - BarChart → LineChart degistir
  - Bar components → 4 Line component (ayni renkler)
  - Compare overlay: previous_vacuum_count Bar → previous_vacuum_total tek dashed line
  - Title: "Vacuum & Analyze Aktivitesi"
  - colSpan degismez
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [x] 7. Frontend build dogrulama
  - `ui` klasorunde `npx tsc --noEmit` ve `npm run build` calistir
  - _Requirements: 5.1, 5.3_

## Notes

- DB sema degisikligi yok — mevcut kolonlar kullanilir
- Yeni paket eklenmez — Line/LineChart zaten recharts'tan import ediliyor
- Bar/BarChart import'u kaldirilmaz (baska yerlerde kullaniliyor)
- Sadece Vacuum Lag sekmesi etkilenir
