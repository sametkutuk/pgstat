import fs from 'fs';
import path from 'path';
import type { Pool } from 'pg';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';

export interface InstanceInventoryReportRow {
  instance_id: string;
  display_name: string;
  host: string;
  port: number;
  pg_major: number | null;
  is_primary: boolean | null;
  environment: string | null;
  datname: string | null;
  size_bytes: number | null;
  size_human: string | null;
  instance_total_bytes: number;
  instance_total_human: string;
}

interface SizeSource {
  sql: string;
}

const SUMMARY_HEADERS = [
  'Instance Ad\u0131',
  'Host',
  'Port',
  'Rol',
  'Environment',
  'PG S\u00fcr\u00fcm',
  'DB Say\u0131s\u0131',
  'Toplam Instance Boyutu',
  'Toplam Instance Boyutu (bytes)',
];

const DETAIL_HEADERS = [
  'Instance Ad\u0131',
  'Database Ad\u0131',
  'Boyut',
  'Boyut (bytes)',
];

interface InstanceInventoryGroup {
  instance_id: string;
  display_name: string;
  host: string;
  port: number;
  pg_major: number | null;
  is_primary: boolean | null;
  environment: string | null;
  instance_total_bytes: number;
  instance_total_human: string;
  databases: InstanceInventoryReportRow[];
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function formatBytes(value: number | string | null | undefined): string | null {
  if (value == null) return null;
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return null;
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timestampParts(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    file: `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`,
    display: `${date.toLocaleDateString('tr-TR')} ${date.toLocaleTimeString('tr-TR')}`,
  };
}

export function inventoryReportFilename(format: 'pdf' | 'xlsx', date = new Date()): string {
  return `pgstat-instance-envanteri-${timestampParts(date).file}.${format}`;
}

async function hasColumn(pool: Pool, tableSchema: string, tableName: string, columnName: string): Promise<boolean> {
  const result = await pool.query(
    `select 1 from information_schema.columns
     where table_schema = $1 and table_name = $2 and column_name = $3
     limit 1`,
    [tableSchema, tableName, columnName],
  );
  return (result.rowCount ?? 0) > 0;
}

async function resolveGenericStorageSource(pool: Pool): Promise<SizeSource | null> {
  const result = await pool.query<{ column_name: string }>(
    `select column_name
     from information_schema.columns
     where table_schema = 'fact' and table_name = 'pg_storage_snapshot'`,
  );
  const columns = new Set(result.rows.map(r => r.column_name));
  if (!columns.has('instance_pk') || !columns.has('dbid')) return null;

  const tsCol = ['sample_ts', 'snapshot_ts', 'collected_at'].find(c => columns.has(c));
  const sizeCol = ['pg_database_size', 'database_size_bytes', 'db_size_bytes', 'size_bytes'].find(c => columns.has(c));
  if (!tsCol || !sizeCol) return null;

  const ts = quoteIdent(tsCol);
  const size = quoteIdent(sizeCol);
  const datname = columns.has('datname') ? 's."datname"' : 'null::text';
  return {
    sql: `
      select
        s."instance_pk"::bigint as instance_pk,
        s."dbid"::bigint as dbid,
        ${datname} as datname,
        s.${size}::bigint as size_bytes
      from fact.pg_storage_snapshot s
      join (
        select "instance_pk", "dbid", max(${ts}) as snapshot_ts
        from fact.pg_storage_snapshot
        group by "instance_pk", "dbid"
      ) latest on latest."instance_pk" = s."instance_pk"
        and latest."dbid" = s."dbid"
        and latest.snapshot_ts = s.${ts}
    `,
  };
}

async function resolveSizeSource(pool: Pool): Promise<SizeSource> {
  const storageSource = await resolveGenericStorageSource(pool);
  if (storageSource) return storageSource;

  if (await hasColumn(pool, 'fact', 'pg_database_delta', 'db_size_bytes')) {
    return {
      sql: `
        select
          d.instance_pk::bigint as instance_pk,
          d.dbid::bigint as dbid,
          d.datname as datname,
          d.db_size_bytes::bigint as size_bytes
        from fact.pg_database_delta d
        join (
          select instance_pk, dbid, max(sample_ts) as sample_ts
          from fact.pg_database_delta
          group by instance_pk, dbid
        ) latest on latest.instance_pk = d.instance_pk
          and latest.dbid = d.dbid
          and latest.sample_ts = d.sample_ts
      `,
    };
  }

  return {
    sql: `
      select
        rs.instance_pk::bigint as instance_pk,
        rs.dbid::bigint as dbid,
        null::text as datname,
        sum(coalesce(rs.total_size_bytes, 0))::bigint as size_bytes
      from fact.pg_relation_size_snapshot rs
      join (
        select instance_pk, dbid, max(snapshot_ts) as snapshot_ts
        from fact.pg_relation_size_snapshot
        group by instance_pk, dbid
      ) latest on latest.instance_pk = rs.instance_pk
        and latest.dbid = rs.dbid
        and latest.snapshot_ts = rs.snapshot_ts
      group by rs.instance_pk, rs.dbid
    `,
  };
}

export async function getInstanceInventoryReportRows(pool: Pool): Promise<InstanceInventoryReportRow[]> {
  const source = await resolveSizeSource(pool);
  const result = await pool.query(`
    with active_instances as (
      select
        i.instance_pk,
        i.instance_id,
        i.display_name,
        i.host,
        i.port,
        i.environment,
        c.pg_major,
        c.is_primary
      from control.instance_inventory i
      left join control.instance_capability c on c.instance_pk = i.instance_pk
      where i.is_active = true
    ),
    size_by_db as (${source.sql}),
    db_keys as (
      select
        x.instance_pk,
        x.dbid,
        coalesce(max(x.datname) filter (where x.datname is not null and x.datname <> ''), '(unknown)') as datname
      from (
        select d.instance_pk, d.dbid::bigint as dbid, d.datname
        from dim.database_ref d
        join active_instances ai on ai.instance_pk = d.instance_pk
        union all
        select s.instance_pk, s.dbid, s.datname
        from size_by_db s
      ) x
      group by x.instance_pk, x.dbid
    ),
    report_rows as (
      select
        ai.instance_id,
        ai.display_name,
        ai.host,
        ai.port,
        ai.pg_major,
        ai.is_primary,
        ai.environment,
        dk.datname,
        s.size_bytes,
        coalesce(sum(coalesce(s.size_bytes, 0)) over (partition by ai.instance_pk), 0)::bigint as instance_total_bytes
      from active_instances ai
      join db_keys dk on dk.instance_pk = ai.instance_pk
      left join size_by_db s on s.instance_pk = dk.instance_pk and s.dbid = dk.dbid
    )
    select *
    from report_rows
    order by display_name, datname
  `);

  return result.rows.map((r: any) => {
    const sizeBytes = toNumberOrNull(r.size_bytes);
    const totalBytes = Number(r.instance_total_bytes || 0);
    return {
      instance_id: r.instance_id,
      display_name: r.display_name,
      host: r.host,
      port: Number(r.port),
      pg_major: toNumberOrNull(r.pg_major),
      is_primary: r.is_primary,
      environment: r.environment,
      datname: r.datname,
      size_bytes: sizeBytes,
      size_human: formatBytes(sizeBytes),
      instance_total_bytes: totalBytes,
      instance_total_human: formatBytes(totalBytes) ?? '0 B',
    };
  });
}

function roleLabel(value: boolean | null): string {
  if (value == null) return '-';
  return value ? 'Primary' : 'Standby';
}

function pgVersionLabel(value: number | null): string {
  return value ? `PG${value}` : '-';
}

function groupRows(rows: InstanceInventoryReportRow[]): InstanceInventoryGroup[] {
  const groups = new Map<string, InstanceInventoryGroup>();
  for (const row of rows) {
    const key = row.instance_id || row.display_name;
    let group = groups.get(key);
    if (!group) {
      group = {
        instance_id: row.instance_id,
        display_name: row.display_name,
        host: row.host,
        port: row.port,
        pg_major: row.pg_major,
        is_primary: row.is_primary,
        environment: row.environment,
        instance_total_bytes: row.instance_total_bytes,
        instance_total_human: row.instance_total_human,
        databases: [],
      };
      groups.set(key, group);
    }
    group.databases.push(row);
  }
  return Array.from(groups.values());
}

function transliterateTurkish(value: string): string {
  return value
    .replace(/\u011f/g, 'g').replace(/\u011e/g, 'G')
    .replace(/\u00fc/g, 'u').replace(/\u00dc/g, 'U')
    .replace(/\u015f/g, 's').replace(/\u015e/g, 'S')
    .replace(/\u0131/g, 'i').replace(/\u0130/g, 'I')
    .replace(/\u00f6/g, 'o').replace(/\u00d6/g, 'O')
    .replace(/\u00e7/g, 'c').replace(/\u00c7/g, 'C');
}

function resolveBundledFont(filename: string): string | null {
  const candidates = [
    path.join(__dirname, 'fonts', filename),
    path.join(process.cwd(), 'src', 'services', 'fonts', filename),
    path.join(process.cwd(), 'dist', 'services', 'fonts', filename),
  ];
  return candidates.find(p => fs.existsSync(p)) ?? null;
}

function resolvePdfFonts(): { regular: string | null; bold: string | null } {
  const regular = resolveBundledFont('NotoSans-Regular.ttf');
  const bold = resolveBundledFont('NotoSans-Bold.ttf');
  if (regular && bold) return { regular, bold };
  return { regular: null, bold: null };
}

export function generateInstanceInventoryPdf(rows: InstanceInventoryReportRow[], date = new Date()): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
    const chunks: Buffer[] = [];
    const fonts = resolvePdfFonts();
    const hasTurkishFont = Boolean(fonts.regular && fonts.bold);
    if (fonts.regular && fonts.bold) {
      doc.registerFont('TR', fonts.regular);
      doc.registerFont('TR-Bold', fonts.bold);
    }
    const font = hasTurkishFont ? 'TR' : 'Helvetica';
    const boldFont = hasTurkishFont ? 'TR-Bold' : 'Helvetica-Bold';
    const tr = (value: string) => hasTurkishFont ? value : transliterateTurkish(value);

    doc.on('data', chunk => chunks.push(Buffer.from(chunk)));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const ts = timestampParts(date).display;
    const margin = 28;
    // Tablo bu degere kadar yazilir, altindan footer cizilir.
    // bottomMargin = footer + alttan emniyet payi (~15pt)
    const bottomMargin = 22;
    // pdfkit'in otomatik sayfa kirilmasini engelle — sadece bizim
    // ensureSpace fonksiyonumuz sayfa acar. Aksi halde text() cagrisi
    // y koordinati sayfa altinda kalinca otomatik bos sayfa aciyor.
    doc.on('pageAdded', () => { y = margin; });
    const contentWidth = doc.page.width - margin * 2;
    const rowHeight = 18;

    // Kolon tan\u0131mlar\u0131 \u2014 orijinal tablo format\u0131, t\u00fcm kolonlar tek sat\u0131rda
    // \u0130lk N "instance kolonu" tekrar etmez (ayn\u0131 instance'\u0131n 2-N sat\u0131r\u0131nda bo\u015f g\u00f6sterilir)
    // Sayfa: A4 landscape = 842pt - 2*28 margin = 786pt kullan\u0131labilir
    // Toplam kolon geni\u015fli\u011fi 780 civar\u0131nda tutulmal\u0131 (ta\u015fma olmas\u0131n)
    const columns: Array<{ header: string; key: string; width: number; align?: 'left' | 'right'; isInstance?: boolean; numeric?: boolean }> = [
      { header: 'Instance Ad\u0131', key: 'display_name', width: 125, isInstance: true },
      { header: 'Host', key: 'host', width: 80, isInstance: true },
      { header: 'Port', key: 'port', width: 35, isInstance: true },
      { header: 'PG S\u00fcr\u00fcm', key: 'pg_major', width: 48, isInstance: true },
      { header: 'Rol', key: 'role', width: 48, isInstance: true },
      { header: 'Env', key: 'environment', width: 50, isInstance: true },
      { header: 'Database Ad\u0131', key: 'datname', width: 125 },
      { header: 'Boyut', key: 'size_human', width: 65, align: 'right' },
      { header: 'Boyut (bytes)', key: 'size_bytes', width: 95, align: 'right', numeric: true },
      { header: 'Instance Toplam', key: 'instance_total_human', width: 80, align: 'right', isInstance: true },
    ];
    // Toplam: 125+80+35+48+48+50+125+65+95+80 = 751pt (786pt s\u0131n\u0131r\u0131na emniyetle s\u0131\u011f\u0131yor)
    const tableWidth = columns.reduce((s, c) => s + c.width, 0);
    const colX = (idx: number) => margin + columns.slice(0, idx).reduce((s, c) => s + c.width, 0);

    let y = margin;
    // Footer kaldirildi \u2014 "pgstat tarafindan olusturuldu" zaten sayfa
    // basligindaki "Olusturulma zamani" satirinda var, alt footer bos
    // sayfa sorununa neden oluyordu.

    const drawReportHeader = (isFirstPage: boolean) => {
      if (isFirstPage) {
        // Ilk sayfa: tam baslik + "pgstat tarafindan olusturuldu" metadata
        doc.font(boldFont).fontSize(15).fillColor('#111827').text(tr('PostgreSQL Instance Envanteri'), margin, y);
        doc.font(font).fontSize(8).fillColor('#475569').text(
          tr('pgstat taraf\u0131ndan olu\u015fturuldu - ' + ts),
          margin, y + 22,
          { width: contentWidth, lineBreak: false },
        );
        y += 44;
      } else {
        // Diger sayfalar: sadece kompakt baslik (yer kazanmak icin)
        doc.font(boldFont).fontSize(11).fillColor('#111827').text(tr('PostgreSQL Instance Envanteri'), margin, y);
        y += 22;
      }
    };

    const drawTableHeader = () => {
      doc.rect(margin, y, tableWidth, rowHeight + 2).fill('#1E3A8A');
      doc.font(boldFont).fontSize(7).fillColor('#FFFFFF');
      columns.forEach((c, i) => {
        doc.text(tr(c.header), colX(i) + 4, y + 6, {
          width: c.width - 8,
          align: c.align ?? 'left',
          lineBreak: false,
          ellipsis: true,
        });
      });
      y += rowHeight + 2;
    };

    const ensureSpace = (neededHeight: number): boolean => {
      if (y + neededHeight <= doc.page.height - bottomMargin) return false;
      doc.addPage({ size: 'A4', layout: 'landscape', margin });
      drawReportHeader(false);
      drawTableHeader();
      return true;
    };

    drawReportHeader(true);
    drawTableHeader();

    let prevInstanceKey = '';
    let zebraIdx = 0;
    rows.forEach(row => {
      ensureSpace(rowHeight);
      // Zebra sat\u0131r
      if (zebraIdx % 2 === 0) {
        doc.rect(margin, y, tableWidth, rowHeight).fill('#F8FAFC');
      }
      zebraIdx++;

      const instanceKey = row.instance_id;
      const isFirstOfInstance = instanceKey !== prevInstanceKey;
      // Yeni instance ba\u015fl\u0131yorsa \u00fcst ince \u00e7izgi
      if (isFirstOfInstance && prevInstanceKey !== '') {
        doc.strokeColor('#CBD5E1').lineWidth(0.5).moveTo(margin, y).lineTo(margin + tableWidth, y).stroke();
      }

      doc.font(font).fontSize(7).fillColor('#111827');
      columns.forEach((c, i) => {
        // Instance kolonlar\u0131 sadece grup ba\u015f\u0131nda yaz\u0131l\u0131r
        const skipInstance = c.isInstance && !isFirstOfInstance;
        let val: string;
        if (skipInstance) {
          val = '';
        } else {
          switch (c.key) {
            case 'display_name': val = row.display_name; break;
            case 'host': val = row.host; break;
            case 'port': val = String(row.port); break;
            case 'pg_major': val = pgVersionLabel(row.pg_major); break;
            case 'role': val = roleLabel(row.is_primary); break;
            case 'environment': val = row.environment || '-'; break;
            case 'datname': val = row.datname || '-'; break;
            case 'size_human': val = row.size_human || '\u2014'; break;
            case 'size_bytes': val = c.numeric && row.size_bytes != null ? row.size_bytes.toLocaleString('tr-TR') : '0'; break;
            case 'instance_total_human': val = row.instance_total_human; break;
            default: val = '';
          }
        }
        doc.text(tr(val), colX(i) + 4, y + 5, {
          width: c.width - 8,
          align: c.align ?? 'left',
          lineBreak: false,
          ellipsis: true,
        });
      });

      y += rowHeight;
      prevInstanceKey = instanceKey;
    });
    doc.end();
  });
}

function styleReportSheet(sheet: ExcelJS.Worksheet, headerToColumnCount: number, numericKeys: string[]) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
  header.alignment = { vertical: 'middle' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headerToColumnCount },
  };
  numericKeys.forEach(key => {
    sheet.getColumn(key).numFmt = '#,##0';
  });
  sheet.columns.forEach(column => {
    let max = String(column.header ?? '').length;
    column.eachCell?.({ includeEmpty: true }, cell => {
      max = Math.max(max, String(cell.value ?? '').length);
    });
    column.width = Math.min(Math.max(max + 2, column.width ?? 10), 42);
  });
}

export async function generateInstanceInventoryXlsx(rows: InstanceInventoryReportRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'pgstat';
  workbook.created = new Date();
  const groups = groupRows(rows);

  const summary = workbook.addWorksheet('\u00d6zet');
  summary.columns = [
    { header: SUMMARY_HEADERS[0], key: 'display_name', width: 28 },
    { header: SUMMARY_HEADERS[1], key: 'host', width: 18 },
    { header: SUMMARY_HEADERS[2], key: 'port', width: 10 },
    { header: SUMMARY_HEADERS[3], key: 'role', width: 12 },
    { header: SUMMARY_HEADERS[4], key: 'environment', width: 16 },
    { header: SUMMARY_HEADERS[5], key: 'pg_major', width: 12 },
    { header: SUMMARY_HEADERS[6], key: 'db_count', width: 12 },
    { header: SUMMARY_HEADERS[7], key: 'instance_total_human', width: 22 },
    { header: SUMMARY_HEADERS[8], key: 'instance_total_bytes', width: 24 },
  ];
  groups.forEach(group => {
    summary.addRow({
      display_name: group.display_name,
      host: group.host,
      port: group.port,
      role: roleLabel(group.is_primary),
      environment: group.environment || '-',
      pg_major: pgVersionLabel(group.pg_major),
      db_count: group.databases.length,
      instance_total_human: group.instance_total_human,
      instance_total_bytes: group.instance_total_bytes,
    });
  });
  styleReportSheet(summary, SUMMARY_HEADERS.length, ['instance_total_bytes']);

  const detail = workbook.addWorksheet('Detay');
  detail.columns = [
    { header: DETAIL_HEADERS[0], key: 'display_name', width: 28 },
    { header: DETAIL_HEADERS[1], key: 'datname', width: 28 },
    { header: DETAIL_HEADERS[2], key: 'size_human', width: 16 },
    { header: DETAIL_HEADERS[3], key: 'size_bytes', width: 18 },
  ];
  rows.forEach(row => {
    detail.addRow({
      display_name: row.display_name,
      datname: row.datname || '-',
      size_human: row.size_human || '-',
      size_bytes: row.size_bytes ?? 0,
    });
  });
  styleReportSheet(detail, DETAIL_HEADERS.length, ['size_bytes']);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}
