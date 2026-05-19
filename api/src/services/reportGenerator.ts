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
    const groups = groupRows(rows);
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
    const bottomMargin = 34;
    const contentWidth = doc.page.width - margin * 2;
    const tableWidth = Math.min(540, contentWidth);
    const dbColWidth = tableWidth - 130;
    const sizeColWidth = 130;
    const rowHeight = 18;
    let y = margin;

    const drawFooter = () => {
      doc.font(font).fontSize(7).fillColor('#64748B').text(
        tr('pgstat taraf\u0131ndan olu\u015fturuldu - ' + ts),
        margin,
        doc.page.height - bottomMargin - 8,
        { width: contentWidth, align: 'center', lineBreak: false },
      );
    };

    const drawReportHeader = () => {
      doc.font(boldFont).fontSize(15).fillColor('#111827').text(tr('PostgreSQL Instance Envanteri'), margin, y);
      doc.font(font).fontSize(8).fillColor('#475569').text(tr('Olu\u015fturulma zaman\u0131: ' + ts), margin, y + 22);
      y += 44;
    };

    const ensureSpace = (neededHeight: number): boolean => {
      if (y + neededHeight <= doc.page.height - bottomMargin) return false;
      drawFooter();
      doc.addPage({ size: 'A4', layout: 'landscape', margin });
      y = margin;
      drawReportHeader();
      return true;
    };

    const drawDbHeader = () => {
      ensureSpace(rowHeight);
      doc.rect(margin, y, tableWidth, rowHeight).fill('#E2E8F0');
      doc.font(boldFont).fontSize(8).fillColor('#0F172A');
      doc.text(tr('Database Ad\u0131'), margin + 6, y + 5, { width: dbColWidth - 12, ellipsis: true });
      doc.text(tr('Boyut'), margin + dbColWidth + 6, y + 5, { width: sizeColWidth - 12, align: 'right', ellipsis: true });
      y += rowHeight;
    };

    const drawInstanceHeader = (group: InstanceInventoryGroup) => {
      ensureSpace(82);
      doc.rect(margin, y, contentWidth, 54).fill('#F8FAFC').strokeColor('#CBD5E1').stroke();
      doc.font(boldFont).fontSize(10).fillColor('#0F172A').text(tr('[INSTANCE: ' + group.display_name + ']'), margin + 8, y + 7, { width: contentWidth - 16, ellipsis: true });
      doc.font(font).fontSize(8).fillColor('#334155');
      doc.text(tr('Host: ' + group.host + ':' + group.port), margin + 8, y + 25, { width: 220, ellipsis: true });
      doc.text(tr('Rol: ' + roleLabel(group.is_primary)), margin + 250, y + 25, { width: 110, ellipsis: true });
      doc.text(tr('Env: ' + (group.environment || '-')), margin + 380, y + 25, { width: 120, ellipsis: true });
      doc.text(tr('PG S\u00fcr\u00fcm\u00fc: ' + pgVersionLabel(group.pg_major)), margin + 8, y + 39, { width: 180, ellipsis: true });
      doc.text(tr('Toplam: ' + group.instance_total_human), margin + 250, y + 39, { width: 130, ellipsis: true });
      doc.text(tr('DB Say\u0131s\u0131: ' + group.databases.length), margin + 380, y + 39, { width: 120, ellipsis: true });
      y += 62;
      drawDbHeader();
    };

    drawReportHeader();
    groups.forEach((group, groupIndex) => {
      if (groupIndex > 0) {
        ensureSpace(18);
        doc.strokeColor('#E2E8F0').moveTo(margin, y).lineTo(margin + contentWidth, y).stroke();
        y += 12;
      }
      drawInstanceHeader(group);
      group.databases.forEach((row, rowIndex) => {
        if (ensureSpace(rowHeight + rowHeight)) {
          doc.font(boldFont).fontSize(8).fillColor('#0F172A').text(tr('[INSTANCE: ' + group.display_name + ' - devam]'), margin, y, { width: contentWidth, ellipsis: true });
          y += 16;
          drawDbHeader();
        }
        if (rowIndex % 2 === 0) doc.rect(margin, y, tableWidth, rowHeight).fill('#F8FAFC');
        doc.font(font).fontSize(8).fillColor('#111827');
        doc.text(tr(row.datname || '-'), margin + 6, y + 5, { width: dbColWidth - 12, ellipsis: true });
        doc.text(tr(row.size_human || '-'), margin + dbColWidth + 6, y + 5, { width: sizeColWidth - 12, align: 'right', ellipsis: true });
        doc.strokeColor('#E5E7EB').moveTo(margin, y + rowHeight).lineTo(margin + tableWidth, y + rowHeight).stroke();
        y += rowHeight;
      });
      y += 8;
    });
    drawFooter();
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
