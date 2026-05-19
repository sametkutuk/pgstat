import fs from 'fs';
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

const REPORT_HEADERS = [
  'Instance Adı',
  'Host',
  'Port',
  'PG Sürüm',
  'Rol',
  'Environment',
  'Database Adı',
  'Database Boyutu',
  'Database Boyutu (bytes)',
  'Toplam Instance Boyutu',
];

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
  if (value == null) return '—';
  return value ? 'Primary' : 'Standby';
}

function pgVersionLabel(value: number | null): string {
  return value ? `PG${value}` : '—';
}

function rowValues(row: InstanceInventoryReportRow): Array<string | number> {
  return [
    row.display_name,
    row.host,
    row.port,
    pgVersionLabel(row.pg_major),
    roleLabel(row.is_primary),
    row.environment || '—',
    row.datname || '—',
    row.size_human || '—',
    row.size_bytes ?? 0,
    row.instance_total_human,
  ];
}

function resolvePdfFont(): string | null {
  const candidates = [
    'C:\\Windows\\Fonts\\arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  ];
  return candidates.find(p => fs.existsSync(p)) ?? null;
}

export function generateInstanceInventoryPdf(rows: InstanceInventoryReportRow[], date = new Date()): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 24, bufferPages: true });
    const chunks: Buffer[] = [];
    const fontPath = resolvePdfFont();
    if (fontPath) doc.registerFont('ReportFont', fontPath);
    const font = fontPath ? 'ReportFont' : 'Helvetica';
    const boldFont = fontPath ? 'ReportFont' : 'Helvetica-Bold';

    doc.on('data', chunk => chunks.push(Buffer.from(chunk)));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const ts = timestampParts(date).display;
    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const margin = 24;
    const widths = [112, 82, 34, 48, 55, 65, 104, 76, 82, 92];
    const rowHeight = 19;
    const tableLeft = margin;
    let y = margin;

    const drawHeader = () => {
      doc.font(boldFont).fontSize(15).fillColor('#111827').text('PostgreSQL Instance Envanteri', tableLeft, y);
      doc.font(font).fontSize(8).fillColor('#475569').text(`Oluşturma zamanı: ${ts}`, tableLeft, y + 20);
      y += 40;
      let x = tableLeft;
      doc.rect(tableLeft, y, pageWidth - margin * 2, rowHeight).fill('#E2E8F0');
      doc.font(boldFont).fontSize(6.5).fillColor('#0F172A');
      REPORT_HEADERS.forEach((h, i) => {
        doc.text(h, x + 3, y + 5, { width: widths[i] - 6, height: rowHeight - 6, ellipsis: true });
        x += widths[i];
      });
      y += rowHeight;
    };

    const drawFooter = () => {
      const footer = `pgstat tarafından oluşturuldu - ${ts}`;
      doc.font(font).fontSize(7).fillColor('#64748B').text(footer, margin, pageHeight - 18, {
        width: pageWidth - margin * 2,
        align: 'center',
      });
    };

    drawHeader();
    rows.forEach((row, index) => {
      if (y + rowHeight > pageHeight - 32) {
        drawFooter();
        doc.addPage({ size: 'A4', layout: 'landscape', margin });
        y = margin;
        drawHeader();
      }
      let x = tableLeft;
      if (index % 2 === 0) doc.rect(tableLeft, y, pageWidth - margin * 2, rowHeight).fill('#F8FAFC');
      doc.font(font).fontSize(6.7).fillColor('#111827');
      rowValues(row).forEach((value, i) => {
        doc.text(String(value), x + 3, y + 5, { width: widths[i] - 6, height: rowHeight - 6, ellipsis: true });
        x += widths[i];
      });
      doc.strokeColor('#E5E7EB').moveTo(tableLeft, y + rowHeight).lineTo(pageWidth - margin, y + rowHeight).stroke();
      y += rowHeight;
    });
    drawFooter();
    doc.end();
  });
}

export async function generateInstanceInventoryXlsx(rows: InstanceInventoryReportRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'pgstat';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Instance Envanteri');
  sheet.columns = [
    { header: REPORT_HEADERS[0], key: 'display_name', width: 28 },
    { header: REPORT_HEADERS[1], key: 'host', width: 18 },
    { header: REPORT_HEADERS[2], key: 'port', width: 10 },
    { header: REPORT_HEADERS[3], key: 'pg_major', width: 12 },
    { header: REPORT_HEADERS[4], key: 'role', width: 12 },
    { header: REPORT_HEADERS[5], key: 'environment', width: 16 },
    { header: REPORT_HEADERS[6], key: 'datname', width: 28 },
    { header: REPORT_HEADERS[7], key: 'size_human', width: 18 },
    { header: REPORT_HEADERS[8], key: 'size_bytes', width: 20 },
    { header: REPORT_HEADERS[9], key: 'instance_total_human', width: 22 },
  ];

  rows.forEach(row => {
    sheet.addRow({
      display_name: row.display_name,
      host: row.host,
      port: row.port,
      pg_major: pgVersionLabel(row.pg_major),
      role: roleLabel(row.is_primary),
      environment: row.environment || '—',
      datname: row.datname || '—',
      size_human: row.size_human || '—',
      size_bytes: row.size_bytes ?? 0,
      instance_total_human: row.instance_total_human,
    });
  });

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
  header.alignment = { vertical: 'middle' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'J1' };
  sheet.getColumn('size_bytes').numFmt = '#,##0';

  sheet.columns.forEach(column => {
    let max = String(column.header ?? '').length;
    column.eachCell?.({ includeEmpty: true }, cell => {
      max = Math.max(max, String(cell.value ?? '').length);
    });
    column.width = Math.min(Math.max(max + 2, column.width ?? 10), 42);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}
