import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const rel = (...parts) => path.join(root, ...parts);
const posix = (p) => p.split(path.sep).join('/');

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function listFiles(dir, predicate = () => true) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, predicate));
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function cleanSql(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ');
}

function normalizeSpace(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function ascii(s) {
  return String(s ?? '').replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

function stripJsComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ');
}

function splitTopLevelComma(body) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    const prev = body[i - 1];
    if ((ch === "'" || ch === '"') && prev !== '\\') {
      quote = quote === ch ? null : quote || ch;
    }
    if (!quote) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function findMatchingParen(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    const prev = text[i - 1];
    if ((ch === "'" || ch === '"') && prev !== '\\') {
      quote = quote === ch ? null : quote || ch;
    }
    if (quote) continue;
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractColumnName(def) {
  const match = /^"([^"]+)"\s+/.exec(def) || /^([a-zA-Z_][a-zA-Z0-9_]*)\s+/.exec(def);
  return match?.[1] ?? null;
}

function extractColumnType(def, columnName) {
  let rest = def.trim();
  if (rest.startsWith('"')) {
    rest = rest.replace(/^"[^"]+"\s+/, '');
  } else {
    rest = rest.slice(columnName.length).trim();
  }
  const stop = /\s+(not\s+null|null|default|primary\s+key|references|constraint|check|unique|collate|generated|identity)\b/i;
  const idx = rest.search(stop);
  return normalizeSpace(idx >= 0 ? rest.slice(0, idx) : rest);
}

function parseSchema() {
  const migrationsDir = rel('db', 'migrations');
  const migrations = listFiles(migrationsDir, (f) => f.endsWith('.sql'));
  const tables = new Map();
  const indexes = [];

  for (const file of migrations) {
    const migration = path.basename(file);
    const raw = readText(file);
    const sql = cleanSql(raw);

    const createRegex = /create\s+table\s+(?:if\s+not\s+exists\s+)?((?:"[^"]+"|[a-zA-Z_][\w]*)\.(?:"[^"]+"|[a-zA-Z_][\w]*))\s*\(/gi;
    for (const match of sql.matchAll(createRegex)) {
      const tableName = match[1].replace(/"/g, '');
      const openIndex = match.index + match[0].lastIndexOf('(');
      const closeIndex = findMatchingParen(sql, openIndex);
      if (closeIndex < 0) continue;
      const body = sql.slice(openIndex + 1, closeIndex);
      const tail = sql.slice(closeIndex + 1, closeIndex + 300);
      const partitionMatch = /partition\s+by\s+range\s*\(([^)]+)\)/i.exec(tail);
      const partitioned = Boolean(partitionMatch);
      if (!tables.has(tableName)) {
        tables.set(tableName, {
          name: tableName,
          firstMigration: migration,
          lastMigration: migration,
          partitioned,
          partitionKey: normalizeSpace(partitionMatch?.[1] ?? ''),
          columns: new Map(),
          alteredBy: new Set(),
        });
      }
      const table = tables.get(tableName);
      table.partitioned = table.partitioned || partitioned;
      table.partitionKey ||= normalizeSpace(partitionMatch?.[1] ?? '');
      table.lastMigration = migration;

      for (const part of splitTopLevelComma(body)) {
        const lower = part.toLowerCase();
        if (/^(constraint|primary\s+key|foreign\s+key|unique|check|exclude)\b/.test(lower)) {
          continue;
        }
        const columnName = extractColumnName(part);
        if (!columnName) continue;
        table.columns.set(columnName, {
          name: columnName,
          type: extractColumnType(part, columnName),
          firstMigration: migration,
        });
      }
    }

    const alterRegex = /alter\s+table\s+(?:if\s+exists\s+)?((?:"[^"]+"|[a-zA-Z_][\w]*)\.(?:"[^"]+"|[a-zA-Z_][\w]*))\s+([\s\S]*?);/gi;
    for (const match of sql.matchAll(alterRegex)) {
      const tableName = match[1].replace(/"/g, '');
      const actions = match[2];
      if (!tables.has(tableName)) {
        tables.set(tableName, {
          name: tableName,
          firstMigration: migration,
          lastMigration: migration,
          partitioned: false,
          partitionKey: '',
          columns: new Map(),
          alteredBy: new Set(),
        });
      }
      const table = tables.get(tableName);
      table.lastMigration = migration;
      table.alteredBy.add(migration);
      const addColumnRegex = /add\s+column\s+(?:if\s+not\s+exists\s+)?((?:"[^"]+"|[a-zA-Z_][\w]*))\s+([\s\S]*?)(?=,\s*add\s+column\b|$)/gi;
      for (const add of actions.matchAll(addColumnRegex)) {
        const columnName = add[1].replace(/"/g, '');
        table.columns.set(columnName, {
          name: columnName,
          type: extractColumnType(`${columnName} ${add[2]}`, columnName),
          firstMigration: migration,
        });
      }
    }

    const indexRegex = /create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([a-zA-Z_][\w]*)\s+on\s+((?:"[^"]+"|[a-zA-Z_][\w]*)\.(?:"[^"]+"|[a-zA-Z_][\w]*))/gi;
    for (const match of sql.matchAll(indexRegex)) {
      indexes.push({
        name: match[1],
        table: match[2].replace(/"/g, ''),
        migration,
      });
    }
  }

  return {
    migrations: migrations.map((f) => path.basename(f)),
    tables: [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)),
    indexes,
  };
}

function extractTableRefs(text) {
  const refs = new Set();
  const regex = /\b(control|dim|fact|agg|ops|audit)\.[a-zA-Z_][a-zA-Z0-9_]*/g;
  for (const match of text.matchAll(regex)) refs.add(match[0]);
  return [...refs].sort((a, b) => a.localeCompare(b));
}

function extractJavaStringArray(text, name) {
  const regex = new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\}`, 'm');
  const match = regex.exec(text);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort((a, b) => a.localeCompare(b));
}

function extractRollupEdges(...texts) {
  const edges = [];
  for (const text of texts) {
    const regex = /insert\s+into\s+(agg\.[a-zA-Z_][a-zA-Z0-9_]*)[\s\S]*?from\s+((?:fact|agg)\.[a-zA-Z_][a-zA-Z0-9_]*)/gi;
    for (const match of text.matchAll(regex)) {
      edges.push({ source: match[2], target: match[1] });
    }
  }
  return edges.sort((a, b) => `${a.source}->${a.target}`.localeCompare(`${b.source}->${b.target}`));
}

function parseCollector() {
  const dir = rel('collector', 'src', 'main', 'java', 'com', 'pgstat', 'collector');
  const javaFiles = listFiles(dir, (f) => f.endsWith('.java'));
  const inSubdir = (name) => {
    const prefix = `${path.join(dir, name)}${path.sep}`;
    return (f) => f.startsWith(prefix);
  };
  const sourceFiles = javaFiles.filter(inSubdir('sql'));
  const serviceFiles = javaFiles.filter(inSubdir('service'));
  const repositoryFiles = javaFiles.filter(inSubdir('repository'));
  const collectorFiles = javaFiles.filter(inSubdir('collector'));

  const sourceFamilies = [];
  for (const file of sourceFiles) {
    const text = readText(file);
    const methods = new Set();
    for (const match of text.matchAll(/\b(?:default\s+)?String\s+([a-zA-Z_][\w]*)\s*\(/g)) {
      methods.add(match[1]);
    }
    const pgSources = new Set();
    for (const match of text.matchAll(/\b(pg_stat[a-zA-Z0-9_]*|pg_statio[a-zA-Z0-9_]*|pg_catalog\.[a-zA-Z0-9_]+|pg_[a-zA-Z0-9_]+)\b/g)) {
      pgSources.add(match[1]);
    }
    sourceFamilies.push({
      file: posix(path.relative(root, file)),
      methods: [...methods].sort(),
      pgSources: [...pgSources].sort(),
    });
  }

  const tableRefsByFile = [];
  for (const file of [...collectorFiles, ...repositoryFiles, ...serviceFiles]) {
    const refs = extractTableRefs(readText(file));
    if (refs.length) {
      tableRefsByFile.push({
        file: posix(path.relative(root, file)),
        refs,
      });
    }
  }

  function fileText(fileName) {
    const file = javaFiles.find((f) => path.basename(f) === fileName);
    return file ? readText(file) : '';
  }

  function refsFor(fileName) {
    const text = fileText(fileName);
    return text ? extractTableRefs(text) : [];
  }

  const purgeText = fileText('PurgeEvaluator.java');
  const partitionText = fileText('PartitionManager.java');
  const aggText = fileText('AggRepository.java');

  const purgeGroups = {
    deltaFactTables: extractJavaStringArray(purgeText, 'DELTA_FACT_TABLES'),
    snapshotFactTables: extractJavaStringArray(purgeText, 'SNAPSHOT_FACT_TABLES'),
    hourlyAggTables: extractJavaStringArray(purgeText, 'HOURLY_AGG_TABLES'),
    nightlySnapshotTables: extractJavaStringArray(purgeText, 'NIGHTLY_SNAPSHOT_TABLES'),
  };

  const partitionGroups = {
    dailyFactTables: extractJavaStringArray(partitionText, 'DAILY_FACT_TABLES'),
    monthlyAggTables: extractJavaStringArray(partitionText, 'MONTHLY_AGG_TABLES'),
    yearlyAggTables: ['agg.pgss_daily'],
  };

  return {
    sourceFamilies,
    tableRefsByFile,
    purgeRefs: refsFor('PurgeEvaluator.java'),
    partitionRefs: refsFor('PartitionManager.java'),
    aggRefs: refsFor('AggRepository.java'),
    purgeGroups,
    partitionGroups,
    rollupEdges: extractRollupEdges(aggText, purgeText),
  };
}

function parseApi() {
  const routeFiles = listFiles(rel('api', 'src', 'routes'), (f) => f.endsWith('.ts'));
  const routes = [];
  const registries = [];
  const tableRefs = [];
  for (const file of routeFiles) {
    const text = readText(file);
    const fileRel = posix(path.relative(root, file));
    for (const match of text.matchAll(/router\.(get|post|put|patch|delete)\s*\(\s*([`'"])(.*?)\2/g)) {
      routes.push({
        method: match[1].toUpperCase(),
        path: match[3],
        file: fileRel,
      });
    }
    for (const match of text.matchAll(/\b(?:const|export\s+const)\s+([A-Z0-9_]+_COLUMNS)\b/g)) {
      registries.push({ name: match[1], file: fileRel });
    }
    const refs = extractTableRefs(text);
    if (refs.length) tableRefs.push({ file: fileRel, refs });
  }
  return { routes, registries, tableRefs };
}

function parseUi() {
  const pageFiles = listFiles(rel('ui', 'src'), (f) => f.endsWith('.tsx') || f.endsWith('.ts'));
  const endpointRefs = [];
  for (const file of pageFiles) {
    const text = stripJsComments(readText(file));
    const refs = new Set();
    for (const match of text.matchAll(/[`'"]([^`'"]*\/(?:api\/)?(?:instances|insights|alerts|reports|dashboard|clusters|retention-policies|schedule-profiles|audit|job-runs|preferences|telegram)[^`'"]*)[`'"]/g)) {
      refs.add(match[1]);
    }
    if (refs.size) {
      endpointRefs.push({
        file: posix(path.relative(root, file)),
        refs: [...refs].sort(),
      });
    }
  }
  return { endpointRefs };
}

function groupBySchema(tables) {
  const groups = new Map();
  for (const table of tables) {
    const schema = table.name.split('.')[0];
    if (!groups.has(schema)) groups.set(schema, []);
    groups.get(schema).push(table);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function mdTable(headers, rows) {
  const out = [];
  out.push(`| ${headers.join(' | ')} |`);
  out.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    out.push(`| ${row.map((cell) => ascii(cell).replace(/\|/g, '\\|')).join(' | ')} |`);
  }
  return out.join('\n');
}

function renderInventory({ schema, collector, api, ui }) {
  const lines = [];
  lines.push('# Generated pgstat Project Inventory');
  lines.push('');
  lines.push('Status: generated');
  lines.push('Source: repository static scan');
  lines.push('');
  lines.push('Do not edit this file manually. Run:');
  lines.push('');
  lines.push('```text');
  lines.push('node scripts/generate-doc-inventory.mjs');
  lines.push('# or on systems with make: make docs-inventory');
  lines.push('```');
  lines.push('');
  lines.push('This generated inventory is the bridge between code and the manual project documents. It is intentionally mechanical. Human interpretation belongs in the master document, data source dictionary, data contract registry, and roadmap.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(mdTable(['Area', 'Count'], [
    ['Migrations scanned', schema.migrations.length],
    ['Tables discovered', schema.tables.length],
    ['Columns discovered', schema.tables.reduce((sum, t) => sum + t.columns.size, 0)],
    ['Indexes discovered', schema.indexes.length],
    ['Collector SQL family files', collector.sourceFamilies.length],
    ['API routes discovered', api.routes.length],
    ['API ColumnRegistry objects discovered', api.registries.length],
    ['UI files with endpoint references', ui.endpointRefs.length],
  ]));
  lines.push('');

  lines.push('## Schema Inventory');
  lines.push('');
  for (const [schemaName, tables] of groupBySchema(schema.tables)) {
    lines.push(`### Schema ${schemaName}`);
    lines.push('');
    lines.push(mdTable(['Table', 'Columns', 'Partitioned', 'Partition key', 'First migration', 'Last migration'], tables.map((table) => [
      table.name,
      table.columns.size,
      table.partitioned ? 'yes' : 'no',
      table.partitionKey || '',
      table.firstMigration,
      table.lastMigration,
    ])));
    lines.push('');
    for (const table of tables) {
      lines.push(`<details><summary>${table.name} columns (${table.columns.size})</summary>`);
      lines.push('');
      lines.push(mdTable(['Column', 'Type', 'First migration'], [...table.columns.values()].map((col) => [
        col.name,
        col.type,
        col.firstMigration,
      ])));
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  lines.push('## Retention, Partition, And Rollup Ownership');
  lines.push('');
  lines.push(mdTable(['Owner', 'Tables referenced'], [
    ['PurgeEvaluator', collector.purgeRefs.join(', ') || 'none detected'],
    ['PartitionManager', collector.partitionRefs.join(', ') || 'none detected'],
    ['AggRepository', collector.aggRefs.join(', ') || 'none detected'],
  ]));
  lines.push('');
  lines.push('Any generated table absent from purge/partition ownership must be reviewed before it is treated as retention-complete.');
  lines.push('');

  lines.push('## Collector Source Query Inventory');
  lines.push('');
  for (const family of collector.sourceFamilies) {
    lines.push(`### ${family.file}`);
    lines.push('');
    lines.push(`Methods: ${family.methods.length ? family.methods.map((m) => `\`${m}\``).join(', ') : 'none detected'}`);
    lines.push('');
    lines.push(`PostgreSQL source tokens: ${family.pgSources.length ? family.pgSources.map((s) => `\`${s}\``).join(', ') : 'none detected'}`);
    lines.push('');
  }

  lines.push('## Collector/Repository Table References');
  lines.push('');
  lines.push(mdTable(['File', 'Tables referenced'], collector.tableRefsByFile.map((entry) => [
    entry.file,
    entry.refs.join(', '),
  ])));
  lines.push('');

  lines.push('## API Inventory');
  lines.push('');
  lines.push('### Routes');
  lines.push('');
  lines.push(mdTable(['Method', 'Path', 'File'], api.routes.map((route) => [
    route.method,
    route.path,
    route.file,
  ])));
  lines.push('');
  lines.push('### Column Registries');
  lines.push('');
  lines.push(mdTable(['Registry', 'File'], api.registries.map((registry) => [
    registry.name,
    registry.file,
  ])));
  lines.push('');
  lines.push('### API Table References');
  lines.push('');
  lines.push(mdTable(['File', 'Tables referenced'], api.tableRefs.map((entry) => [
    entry.file,
    entry.refs.join(', '),
  ])));
  lines.push('');

  lines.push('## UI Endpoint References');
  lines.push('');
  lines.push(mdTable(['File', 'Endpoint/string references'], ui.endpointRefs.map((entry) => [
    entry.file,
    entry.refs.join('<br>'),
  ])));
  lines.push('');

  lines.push('## Static Scan Limits');
  lines.push('');
  lines.push('- Dynamic SQL and template strings are detected only as static tokens.');
  lines.push('- This file proves code coverage visibility, not semantic correctness.');
  lines.push('- Field-level meaning, PG version support, retention intent, and consumer stability still belong in the data contract registry.');
  lines.push('- Missing entries here usually mean the scanner must be improved or the code path uses a pattern not yet recognized.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function inferSemantics(table) {
  const [schemaName, tableName] = table.name.split('.');
  if (schemaName === 'agg') return 'aggregate';
  if (schemaName === 'dim') return 'dimension';
  if (schemaName === 'control') return 'control/config';
  if (schemaName === 'ops') return 'operations';
  if (schemaName === 'audit') return 'audit';
  if (tableName.endsWith('_delta')) return 'delta fact';
  if (tableName.includes('_snapshot')) return 'snapshot fact';
  return schemaName;
}

function timestampColumns(table) {
  const names = [...table.columns.keys()];
  return names.filter((name) => (
    name === 'sample_ts' ||
    name === 'snapshot_ts' ||
    name === 'bucket_start' ||
    name === 'hour_ts' ||
    name === 'day_ts' ||
    name.endsWith('_at') ||
    name.endsWith('_time') ||
    name.endsWith('_ts')
  )).sort();
}

function buildLifecycleRows({ schema, collector }) {
  const purgeRefs = new Set(collector.purgeRefs);
  const partitionRefs = new Set(collector.partitionRefs);
  const aggRefs = new Set(collector.aggRefs);
  const rollupSources = new Map();
  const rollupTargets = new Map();
  for (const edge of collector.rollupEdges) {
    if (!rollupSources.has(edge.source)) rollupSources.set(edge.source, []);
    if (!rollupTargets.has(edge.target)) rollupTargets.set(edge.target, []);
    rollupSources.get(edge.source).push(edge.target);
    rollupTargets.get(edge.target).push(edge.source);
  }

  const group = collector.purgeGroups;
  const partitionGroup = collector.partitionGroups;
  const deltaFacts = new Set(group.deltaFactTables);
  const snapshotFacts = new Set(group.snapshotFactTables);
  const hourlyAgg = new Set(group.hourlyAggTables);
  const nightlySnapshots = new Set(group.nightlySnapshotTables);
  const dailyFacts = new Set(partitionGroup.dailyFactTables);
  const monthlyAgg = new Set(partitionGroup.monthlyAggTables);
  const yearlyAgg = new Set(partitionGroup.yearlyAggTables);

  const codeRefs = new Map();
  for (const entry of collector.tableRefsByFile) {
    for (const table of entry.refs) {
      if (!codeRefs.has(table)) codeRefs.set(table, []);
      codeRefs.get(table).push(entry.file);
    }
  }

  function retention(tableName) {
    if (deltaFacts.has(tableName)) return 'control.retention_policy.raw_retention_days/raw_retention_months';
    if (snapshotFacts.has(tableName)) return 'control.retention_policy.snapshot_retention_hours';
    if (nightlySnapshots.has(tableName)) return 'control.retention_policy.nightly_snapshot_retention_days';
    if (tableName === 'fact.pg_table_freeze_snapshot') return 'control.retention_policy.table_freeze_retention_days';
    if (hourlyAgg.has(tableName)) return 'control.retention_policy.hourly_retention_days/hourly_retention_months';
    if (tableName === 'agg.pgss_daily') return 'control.retention_policy.daily_retention_days/daily_retention_months';
    if (tableName === 'ops.audit_log') return 'control.retention_policy.audit_log_retention_days';
    if (tableName === 'ops.alert') return 'control.retention_policy.alert_retention_days (resolved alerts only)';
    if (tableName === 'ops.job_run' || tableName === 'ops.job_run_instance') return 'control.retention_policy.job_run_retention_days';
    if (tableName === 'ops.report_history') return 'control.report_config.daily_retention_days/weekly_retention_days';
    if (tableName === 'ops.notification_log') return 'control.report_config.notification_log_retention_days';
    if (tableName === 'control.telegram_message_map') return 'fixed 7 days in PurgeEvaluator';
    if (purgeRefs.has(tableName)) return 'referenced by PurgeEvaluator; verify policy mapping';
    return 'not detected';
  }

  function partitionPolicy(tableName) {
    if (dailyFacts.has(tableName)) return 'daily partitions by PartitionManager';
    if (monthlyAgg.has(tableName)) return 'monthly partitions by PartitionManager';
    if (yearlyAgg.has(tableName)) return 'yearly partitions by PartitionManager';
    if (partitionRefs.has(tableName)) return 'referenced by PartitionManager; verify group';
    return 'not detected';
  }

  function rollupRole(tableName) {
    const roles = [];
    if (rollupSources.has(tableName)) roles.push(`source -> ${rollupSources.get(tableName).join(', ')}`);
    if (rollupTargets.has(tableName)) roles.push(`target <- ${rollupTargets.get(tableName).join(', ')}`);
    if (!roles.length && aggRefs.has(tableName)) roles.push('referenced by AggRepository; verify role');
    return roles.join('; ') || 'not detected';
  }

  return schema.tables.map((table) => {
    const refs = (codeRefs.get(table.name) ?? []).map((f) => f.replace(/^collector\/src\/main\/java\/com\/pgstat\/collector\//, 'collector/'));
    return {
      table: table.name,
      semantics: inferSemantics(table),
      columns: table.columns.size,
      timestamps: timestampColumns(table).join(', ') || 'none detected',
      schemaPartitioned: table.partitioned ? `yes (${table.partitionKey})` : 'no',
      partitionPolicy: partitionPolicy(table.name),
      retention: retention(table.name),
      purgeOwner: purgeRefs.has(table.name) ? 'yes' : 'no',
      rollup: rollupRole(table.name),
      firstMigration: table.firstMigration,
      lastMigration: table.lastMigration,
      codeRefs: refs.slice(0, 6).join('<br>') + (refs.length > 6 ? `<br>... +${refs.length - 6} more` : ''),
    };
  });
}

const CONTRACT_HINTS = {
  'fact.pgss_delta': {
    job: 'statements',
    schedule: 'control.schedule_profile.statements_interval_seconds',
    source: 'pg_stat_statements(false), pg_stat_statements_info, pg_roles, pg_control_system, pg_postmaster_start_time',
    pgVersion: 'PG11+ via SourceQueries families; pgss extension required; newer pgss columns are version-gated',
    unsupported: 'missing pg_stat_statements fails statements job; unsupported columns are null/zero via source family',
    sensitivity: 'query identity; query text is in dim.query_text',
    pgdbaagent: 'query workload, temp spill, WAL spike, cache hit, latency evidence',
  },
  'dim.statement_series': {
    job: 'statements',
    schedule: 'control.schedule_profile.statements_interval_seconds',
    source: 'pg_stat_statements identifiers + pg_control_system epoch context',
    pgVersion: 'PG11+; toplevel and pgss metadata version-gated',
    unsupported: 'unsupported identity fields stored as null/default by source family',
    sensitivity: 'query identity metadata',
    pgdbaagent: 'stable query identity for evidence packages',
  },
  'dim.query_text': {
    job: 'text_enrichment',
    schedule: 'after statements job; bootstrap_sql_text_batch limits batch size',
    source: 'pg_stat_statements query text',
    pgVersion: 'PG11+ with pg_stat_statements extension',
    unsupported: 'text enrichment skips/fails independently; numeric pgss collection can still exist',
    sensitivity: 'query text; mask/export/AI rules required',
    pgdbaagent: 'query explanation and plan matching context',
  },
  'dim.role_ref': {
    job: 'statements',
    schedule: 'control.schedule_profile.statements_interval_seconds',
    source: 'pg_roles',
    pgVersion: 'PG11+',
    unsupported: 'role refresh warning; pgss collection continues',
    sensitivity: 'role/user names',
    pgdbaagent: 'query owner context',
  },
  'dim.database_ref': {
    job: 'discovery/rediscovery',
    schedule: 'bootstrap + rediscovery hourly',
    source: 'pg_database',
    pgVersion: 'PG11+',
    unsupported: 'database discovery failure blocks/marks bootstrap state',
    sensitivity: 'database names',
    pgdbaagent: 'database scope for findings',
  },
  'dim.relation_ref': {
    job: 'db_objects',
    schedule: 'control.schedule_profile.db_objects_interval_seconds',
    source: 'pg_stat_user_tables, pg_stat_user_indexes, pg_statio_* relids',
    pgVersion: 'PG11+',
    unsupported: 'per-database failures update database_state and may alert',
    sensitivity: 'schema/table/index names',
    pgdbaagent: 'relation identity for index/table findings',
  },
  'fact.pg_database_delta': {
    job: 'db_objects',
    schedule: 'control.schedule_profile.db_objects_interval_seconds',
    source: 'pg_stat_database',
    pgVersion: 'PG11+; checksum PG12+; session counters PG14+; parallel worker counters PG18+',
    unsupported: 'SourceQueries fills unsupported counters as null/zero; per-DB access errors are isolated',
    sensitivity: 'database names and workload counters',
    pgdbaagent: 'database workload, TPS, temp, cache, session evidence',
  },
  'fact.pg_table_stat_delta': {
    job: 'db_objects',
    schedule: 'control.schedule_profile.db_objects_interval_seconds',
    source: 'pg_stat_user_tables, pg_statio_user_tables',
    pgVersion: 'PG11+; newer vacuum/freeze time fields version-gated',
    unsupported: 'SourceQueries fills unsupported fields as null/zero',
    sensitivity: 'schema/table names',
    pgdbaagent: 'vacuum lag, bloat proxy, table health, index advice context',
  },
  'fact.pg_index_stat_delta': {
    job: 'db_objects',
    schedule: 'control.schedule_profile.db_objects_interval_seconds',
    source: 'pg_stat_user_indexes, pg_statio_user_indexes',
    pgVersion: 'PG11+',
    unsupported: 'SourceQueries fills unsupported fields as null/zero',
    sensitivity: 'schema/table/index names',
    pgdbaagent: 'unused/inefficient index and write-risk evidence',
  },
  'fact.pg_cluster_delta': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_bgwriter, pg_stat_wal, pg_stat_checkpointer',
    pgVersion: 'PG11+ bgwriter; pg_stat_wal PG13+; pg_stat_checkpointer PG17+',
    unsupported: 'query method returns null or source family maps missing fields to zero/null',
    sensitivity: 'cluster-level counters only',
    pgdbaagent: 'checkpoint, bgwriter, WAL pressure evidence',
  },
  'fact.pg_io_stat_delta': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_io',
    pgVersion: 'PG16+ only',
    unsupported: 'skipped when pgMajor < 16 or query is null',
    sensitivity: 'backend/object/context I/O counters',
    pgdbaagent: 'I/O bottleneck evidence',
  },
  'fact.pg_activity_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_activity',
    pgVersion: 'PG11+; leader_pid PG13+; query_id PG14+',
    unsupported: 'version family stores unsupported fields as null',
    sensitivity: 'query text, user, application, client host/addr',
    pgdbaagent: 'session/wait/blocking context',
  },
  'fact.pg_replication_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_replication',
    pgVersion: 'PG11+; reply_time PG12+ safe lookup',
    unsupported: 'primary-only; skipped on standby; unsupported columns null',
    sensitivity: 'user/application/client replication metadata',
    pgdbaagent: 'replication lag evidence',
  },
  'fact.pg_lock_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_locks + pg_stat_activity',
    pgVersion: 'PG11+; waitstart PG14+',
    unsupported: 'waitstart null on older PG',
    sensitivity: 'pid/database/relation lock context',
    pgdbaagent: 'blocking and lock-root-cause evidence',
  },
  'fact.pg_progress_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_progress_vacuum/analyze/create_index summary',
    pgVersion: 'version-gated per progress view',
    unsupported: 'query methods returning null are skipped',
    sensitivity: 'relation and operation progress metadata',
    pgdbaagent: 'long operation context',
  },
  'fact.pg_wal_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_current_wal_lsn, pg_last_wal_replay_lsn, pg_walfile_name, pg_ls_waldir',
    pgVersion: 'PG10+ functions; collected through supported SourceQueries',
    unsupported: 'sub-step warning; cluster job continues',
    sensitivity: 'WAL file/LSN metadata',
    pgdbaagent: 'WAL growth and archive pressure evidence',
  },
  'fact.pg_archiver_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_archiver',
    pgVersion: 'PG11+',
    unsupported: 'sub-step warning; cluster job continues',
    sensitivity: 'WAL archive file names/timestamps',
    pgdbaagent: 'archive lag evidence',
  },
  'fact.pg_wal_receiver_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_wal_receiver',
    pgVersion: 'PG11+ standby-only',
    unsupported: 'standby-only; sub-step warning; cluster job continues',
    sensitivity: 'replication connection metadata',
    pgdbaagent: 'standby receive lag evidence',
  },
  'fact.pg_replication_slot_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_replication_slots, pg_stat_replication_slots',
    pgVersion: 'PG11+ slots; pg_stat_replication_slots PG14+; PG17/18 fields safe lookup',
    unsupported: 'unsupported columns null/zero through to_jsonb safe lookup',
    sensitivity: 'slot names, database names, replication state',
    pgdbaagent: 'slot lag, spill, lifecycle evidence',
  },
  'fact.pg_database_conflict_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_database_conflicts',
    pgVersion: 'PG11+; logical slot conflict PG16+ safe lookup',
    unsupported: 'unsupported conflict fields default to zero',
    sensitivity: 'database names and conflict counters',
    pgdbaagent: 'standby conflict evidence',
  },
  'fact.pg_slru_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_slru',
    pgVersion: 'PG13+',
    unsupported: 'query null/skipped on PG11-12',
    sensitivity: 'SLRU area counters',
    pgdbaagent: 'SLRU pressure evidence',
  },
  'fact.pg_subscription_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_subscription, pg_stat_subscription_stats',
    pgVersion: 'PG10+ subscription stats; PG15+ stats view; PG17/18 fields safe lookup',
    unsupported: 'unsupported stats/conflict fields null/zero',
    sensitivity: 'subscription names and replication metadata',
    pgdbaagent: 'logical replication health evidence',
  },
  'fact.pg_recovery_prefetch_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_recovery_prefetch',
    pgVersion: 'PG15+ standby feature',
    unsupported: 'query null/skipped when unsupported',
    sensitivity: 'recovery prefetch counters',
    pgdbaagent: 'standby recovery performance evidence',
  },
  'fact.pg_user_function_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_user_functions',
    pgVersion: 'PG11+; only useful when track_functions enabled',
    unsupported: 'sub-step warning; empty if tracking disabled',
    sensitivity: 'schema/function names',
    pgdbaagent: 'function execution evidence',
  },
  'fact.pg_sequence_io_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_statio_user_sequences',
    pgVersion: 'PG11+',
    unsupported: 'sub-step warning; cluster job continues',
    sensitivity: 'schema/sequence names',
    pgdbaagent: 'sequence I/O evidence',
  },
  'fact.pg_progress_vacuum_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_progress_vacuum',
    pgVersion: 'PG11+',
    unsupported: 'sub-step warning or skipped by source family',
    sensitivity: 'relation operation metadata',
    pgdbaagent: 'vacuum progress evidence',
  },
  'fact.pg_progress_analyze_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_progress_analyze',
    pgVersion: 'PG13+',
    unsupported: 'skipped when query method is null',
    sensitivity: 'relation operation metadata',
    pgdbaagent: 'analyze progress evidence',
  },
  'fact.pg_progress_create_index_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_progress_create_index',
    pgVersion: 'PG12+',
    unsupported: 'skipped when query method is null',
    sensitivity: 'relation/index operation metadata',
    pgdbaagent: 'index build progress evidence',
  },
  'fact.pg_progress_basebackup_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_progress_basebackup',
    pgVersion: 'PG13+ primary-only',
    unsupported: 'skipped when query method is null or standby',
    sensitivity: 'backup progress metadata',
    pgdbaagent: 'backup impact evidence',
  },
  'fact.pg_progress_copy_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_progress_copy',
    pgVersion: 'PG14+',
    unsupported: 'skipped when query method is null',
    sensitivity: 'copy command progress metadata',
    pgdbaagent: 'bulk load progress evidence',
  },
  'fact.pg_progress_cluster_snapshot': {
    job: 'cluster',
    schedule: 'control.schedule_profile.cluster_interval_seconds',
    source: 'pg_stat_progress_cluster',
    pgVersion: 'PG12+',
    unsupported: 'skipped when query method is null',
    sensitivity: 'relation operation metadata',
    pgdbaagent: 'cluster/vacuum full progress evidence',
  },
  'fact.pg_settings_snapshot': {
    job: 'nightly_snapshot/hot_settings/freeze_settings',
    schedule: 'UTC 03:00 full snapshot; hot settings every 3h; freeze/settings every 6h',
    source: 'pg_settings',
    pgVersion: 'PG11+; selected setting names may not exist on every version',
    unsupported: 'missing settings are absent; collector continues',
    sensitivity: 'configuration values; may expose paths, host behavior, tuning choices',
    pgdbaagent: 'parameter tuning and risk context',
  },
  'fact.pg_relation_size_snapshot': {
    job: 'nightly_snapshot',
    schedule: 'UTC 03:00 full snapshot or manual trigger',
    source: 'pg_class, pg_namespace, pg_index, pg_relation_size, pg_total_relation_size',
    pgVersion: 'PG11+',
    unsupported: 'per-database failures logged and skipped',
    sensitivity: 'schema/relation names and sizes',
    pgdbaagent: 'index/table storage and write-risk context',
  },
  'fact.pg_sequence_state_snapshot': {
    job: 'nightly_snapshot',
    schedule: 'UTC 03:00 full snapshot or manual trigger',
    source: 'pg_sequences',
    pgVersion: 'PG10+',
    unsupported: 'per-database failures logged and skipped',
    sensitivity: 'schema/sequence names and current values',
    pgdbaagent: 'sequence exhaustion evidence',
  },
  'fact.pg_database_freeze_snapshot': {
    job: 'nightly_snapshot/freeze_settings',
    schedule: 'UTC 03:00 full snapshot; freeze/settings every 6h',
    source: 'pg_database age(datfrozenxid), mxid_age(datminmxid)',
    pgVersion: 'PG11+',
    unsupported: 'admin connection failure logs warning',
    sensitivity: 'database names and xid ages',
    pgdbaagent: 'wraparound risk evidence',
  },
  'fact.pg_table_freeze_snapshot': {
    job: 'table_freeze_snapshot',
    schedule: 'instance table_freeze_interval_seconds, default 21600s',
    source: 'pg_class, pg_namespace, age(relfrozenxid), mxid_age(relminmxid)',
    pgVersion: 'PG11+',
    unsupported: 'per-database failures logged and skipped',
    sensitivity: 'schema/table names and xid ages',
    pgdbaagent: 'table-level wraparound/autovacuum evidence',
  },
};

function defaultContractHint(tableName, semantics) {
  if (tableName.startsWith('agg.')) {
    return {
      job: 'rollup',
      schedule: 'control.schedule_profile.hourly_rollup_interval_seconds or UTC daily maintenance',
      source: 'central pgstat fact/aggregate tables',
      pgVersion: 'not source-PG specific; inherits source coverage',
      unsupported: 'rollup skips/fails independently; source evidence may be missing',
      sensitivity: 'inherits source table sensitivity',
      pgdbaagent: 'historical trend and baseline evidence',
    };
  }
  if (tableName.startsWith('control.')) {
    return {
      job: 'pgstat application/control plane',
      schedule: 'event-driven or operator-configured',
      source: 'pgstat central database',
      pgVersion: 'not source-PG specific',
      unsupported: 'not applicable',
      sensitivity: 'configuration/control metadata; review before export',
      pgdbaagent: 'control/context when explicitly contracted',
    };
  }
  if (tableName.startsWith('ops.')) {
    return {
      job: 'pgstat operations/alert/report pipeline',
      schedule: 'event-driven and daily maintenance',
      source: 'pgstat central database',
      pgVersion: 'not source-PG specific',
      unsupported: 'not applicable',
      sensitivity: 'operational/audit/notification metadata',
      pgdbaagent: 'operations context when explicitly contracted',
    };
  }
  if (tableName.startsWith('dim.')) {
    return {
      job: 'collector dimension upsert',
      schedule: 'collector-dependent',
      source: 'source PostgreSQL identity/catalog/stat view',
      pgVersion: 'collector-dependent; see SourceQueries and PG matrix',
      unsupported: 'collector-dependent',
      sensitivity: 'object identity metadata',
      pgdbaagent: 'entity identity context',
    };
  }
  return {
    job: 'unknown/verify',
    schedule: 'verify',
    source: 'verify',
    pgVersion: 'verify',
    unsupported: 'verify',
    sensitivity: 'verify',
    pgdbaagent: 'verify',
  };
}

function buildContractRows({ schema, collector, api, ui }) {
  const lifecycleRows = buildLifecycleRows({ schema, collector });
  const lifecycleByTable = new Map(lifecycleRows.map((row) => [row.table, row]));
  const apiByTable = new Map();
  for (const entry of api.tableRefs) {
    const routes = api.routes
      .filter((route) => route.file === entry.file)
      .map((route) => `${route.method} ${route.path}`);
    for (const table of entry.refs) {
      if (!apiByTable.has(table)) apiByTable.set(table, []);
      apiByTable.get(table).push(`${entry.file} (${routes.length} routes)`);
    }
  }

  const uiByApiFile = {
    'api/src/routes/instances.ts': ['ui/src/pages/Instances.tsx', 'ui/src/pages/InstanceDetail.tsx'],
    'api/src/routes/insights.ts': ['ui/src/pages/Insights.tsx'],
    'api/src/routes/statements.ts': ['ui/src/pages/Statements.tsx', 'ui/src/pages/StatementDetail.tsx'],
    'api/src/routes/dashboard.ts': ['ui/src/pages/Dashboard.tsx'],
    'api/src/routes/alerts.ts': ['ui/src/pages/Alerts.tsx', 'ui/src/pages/AlertsHub.tsx'],
    'api/src/routes/alertRules.ts': ['ui/src/pages/AlertRules.tsx'],
    'api/src/routes/reports.ts': ['ui/src/pages/ReportHistory.tsx'],
    'api/src/routes/systemHealth.ts': ['ui/src/pages/SystemHealthDashboard.tsx'],
    'api/src/routes/clusters.ts': ['ui/src/pages/Clusters.tsx', 'ui/src/pages/ClusterDetail.tsx'],
    'api/src/routes/jobRuns.ts': ['ui/src/pages/JobRuns.tsx'],
    'api/src/routes/auditLog.ts': ['ui/src/pages/Settings.tsx'],
    'api/src/routes/retentionPolicies.ts': ['ui/src/pages/Settings.tsx'],
    'api/src/routes/scheduleProfiles.ts': ['ui/src/pages/Settings.tsx'],
  };

  function uiConsumers(tableName) {
    const pages = new Set();
    for (const apiRef of apiByTable.get(tableName) ?? []) {
      const file = apiRef.split(' ')[0];
      for (const page of uiByApiFile[file] ?? []) pages.add(page);
    }
    return [...pages].sort();
  }

  function alertReportConsumers(tableName, codeRefs) {
    const out = [];
    if (codeRefs.includes('AlertRuleEvaluator.java') || codeRefs.includes('AlertService.java') || codeRefs.includes('SystemHealthEvaluator.java')) {
      out.push('alerts');
    }
    if (codeRefs.includes('ReportGenerator.java') || codeRefs.includes('ReportHistoryRepository.java')) {
      out.push('reports');
    }
    if (codeRefs.includes('NotificationService.java') || codeRefs.includes('TelegramCommandPoller.java')) {
      out.push('notifications/telegram');
    }
    return out;
  }

  return schema.tables.map((table) => {
    const lifecycle = lifecycleByTable.get(table.name);
    const semantics = lifecycle?.semantics ?? inferSemantics(table);
    const hint = { ...defaultContractHint(table.name, semantics), ...(CONTRACT_HINTS[table.name] ?? {}) };
    const codeRefs = lifecycle?.codeRefs ?? '';
    const alertReports = alertReportConsumers(table.name, codeRefs);
    return {
      table: table.name,
      semantics,
      collectorJob: hint.job,
      source: hint.source,
      pgVersion: hint.pgVersion,
      schedule: hint.schedule,
      retention: lifecycle?.retention ?? 'not detected',
      purgeSql: lifecycle?.purgeOwner === 'yes' ? 'collector/service/PurgeEvaluator.java' : 'not detected',
      partition: lifecycle?.partitionPolicy ?? 'not detected',
      rollup: lifecycle?.rollup ?? 'not detected',
      api: (apiByTable.get(table.name) ?? []).join('<br>') || 'not detected',
      ui: uiConsumers(table.name).join('<br>') || 'not detected',
      alertReport: alertReports.join(', ') || 'not detected',
      pgdbaagent: hint.pgdbaagent,
      sensitivity: hint.sensitivity,
      unsupported: hint.unsupported,
      contractStatus: CONTRACT_HINTS[table.name] ? 'seeded semantic contract' : 'generated default; needs review',
    };
  });
}

function renderDataFamilyContracts({ schema, collector, api, ui }) {
  const rows = buildContractRows({ schema, collector, api, ui });
  const lines = [];
  lines.push('# Generated pgstat Data Family Contracts');
  lines.push('');
  lines.push('Status: generated seed');
  lines.push('Source: repository static scan + maintained contract hints in scripts/generate-doc-inventory.mjs');
  lines.push('');
  lines.push('Do not edit this file manually. Run:');
  lines.push('');
  lines.push('```text');
  lines.push('node scripts/generate-doc-inventory.mjs');
  lines.push('# or on systems with make: make docs-inventory');
  lines.push('```');
  lines.push('');
  lines.push('This file answers the operational contract questions at table/data-family level. It is not yet a substitute for field-level contracts. Field-level `since_pg`, `removed_pg`, exact unsupported behavior, and downstream stable consumers still belong in the data contract registry.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(mdTable(['Metric', 'Count'], [
    ['Tables analyzed', rows.length],
    ['Seeded semantic contracts', rows.filter((row) => row.contractStatus === 'seeded semantic contract').length],
    ['Generated defaults needing review', rows.filter((row) => row.contractStatus !== 'seeded semantic contract').length],
    ['Tables with detected API consumers', rows.filter((row) => row.api !== 'not detected').length],
    ['Tables with inferred UI consumers', rows.filter((row) => row.ui !== 'not detected').length],
    ['Tables with alert/report/notification consumers', rows.filter((row) => row.alertReport !== 'not detected').length],
  ]));
  lines.push('');
  lines.push('## Contract Matrix');
  lines.push('');
  lines.push(mdTable([
    'Table',
    'Semantics',
    'Collector job',
    'Source PG view/catalog/function',
    'PG version / column gate',
    'Schedule',
    'Retention policy',
    'Purge SQL owner',
    'Partition',
    'Rollup',
    'API consumers',
    'UI consumers',
    'Alert/report consumers',
    'pgdbaagent usage',
    'Sensitive data',
    'Unsupported behavior',
    'Contract status',
  ], rows.map((row) => [
    row.table,
    row.semantics,
    row.collectorJob,
    row.source,
    row.pgVersion,
    row.schedule,
    row.retention,
    row.purgeSql,
    row.partition,
    row.rollup,
    row.api,
    row.ui,
    row.alertReport,
    row.pgdbaagent,
    row.sensitivity,
    row.unsupported,
    row.contractStatus,
  ])));
  lines.push('');
  lines.push('## Static Scan Limits');
  lines.push('');
  lines.push('- API and UI consumers are inferred from route files and known UI route ownership; they are not proof of exact column-level usage.');
  lines.push('- PostgreSQL version coverage is table/data-family level. Exact column-level version coverage must still be promoted into the data contract registry.');
  lines.push('- Security classification is a seeded default and must be reviewed before export/AI use.');
  lines.push('- `generated default; needs review` rows are not considered stable product contracts.');
  return `${lines.join('\n')}\n`;
}

function renderLifecycleMatrix({ schema, collector }) {
  const rows = buildLifecycleRows({ schema, collector });
  const lines = [];
  lines.push('# Generated pgstat Data Lifecycle Matrix');
  lines.push('');
  lines.push('Status: generated');
  lines.push('Source: repository static scan');
  lines.push('');
  lines.push('Do not edit this file manually. Run:');
  lines.push('');
  lines.push('```text');
  lines.push('node scripts/generate-doc-inventory.mjs');
  lines.push('# or on systems with make: make docs-inventory');
  lines.push('```');
  lines.push('');
  lines.push('This matrix answers, mechanically, how each table is stored, whether purge/partition/rollup ownership is visible in code, and which retention policy can be inferred. Human semantic meaning still belongs in the data source dictionary and data contract registry.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  const missingRetention = rows.filter((row) => row.retention === 'not detected').length;
  const missingPartition = rows.filter((row) => row.schemaPartitioned.startsWith('yes') && row.partitionPolicy === 'not detected').length;
  const partitionOwnerWithoutSchema = rows.filter((row) => row.partitionPolicy !== 'not detected' && row.schemaPartitioned === 'no').length;
  const verifyPolicy = rows.filter((row) => row.retention.includes('verify policy mapping')).length;
  lines.push(mdTable(['Metric', 'Count'], [
    ['Tables analyzed', rows.length],
    ['Tables without detected retention mapping', missingRetention],
    ['Partitioned tables without detected PartitionManager ownership', missingPartition],
    ['PartitionManager-owned tables not schema-partitioned in static scan', partitionOwnerWithoutSchema],
    ['Purge-referenced tables requiring policy verification', verifyPolicy],
    ['Rollup edges detected', collector.rollupEdges.length],
  ]));
  lines.push('');
  lines.push('## Lifecycle Matrix');
  lines.push('');
  lines.push(mdTable([
    'Table',
    'Semantics',
    'Columns',
    'Timestamp columns',
    'Schema partitioned',
    'Partition policy',
    'Retention / purge policy',
    'Purge owner',
    'Rollup role',
    'First migration',
    'Last migration',
    'Code refs',
  ], rows.map((row) => [
    row.table,
    row.semantics,
    row.columns,
    row.timestamps,
    row.schemaPartitioned,
    row.partitionPolicy,
    row.retention,
    row.purgeOwner,
    row.rollup,
    row.firstMigration,
    row.lastMigration,
    row.codeRefs,
  ])));
  lines.push('');
  lines.push('## Rollup Edges');
  lines.push('');
  lines.push(mdTable(['Source', 'Target'], collector.rollupEdges.map((edge) => [edge.source, edge.target])));
  lines.push('');
  lines.push('## Static Scan Limits');
  lines.push('');
  lines.push('- Retention policy mapping is inferred from current Java arrays and explicit purge methods.');
  lines.push('- `referenced by PurgeEvaluator; verify policy mapping` means the table token appears in purge code, but this generator did not classify it into a specific retention policy branch.');
  lines.push('- `not detected` does not automatically mean a bug. Some control/dim tables are intentionally persistent. It does mean the table needs a documented lifecycle decision.');
  lines.push('- Runtime database schema verification is not performed by this generator.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const schema = parseSchema();
const collector = parseCollector();
const api = parseApi();
const ui = parseUi();

writeText(rel('docs', 'generated', 'project-inventory.md'), renderInventory({
  schema,
  collector,
  api,
  ui,
}));

writeText(rel('docs', 'generated', 'data-lifecycle-matrix.md'), renderLifecycleMatrix({
  schema,
  collector,
}));

writeText(rel('docs', 'generated', 'data-family-contracts.md'), renderDataFamilyContracts({
  schema,
  collector,
  api,
  ui,
}));

console.log('Generated docs/generated/project-inventory.md');
console.log('Generated docs/generated/data-lifecycle-matrix.md');
console.log('Generated docs/generated/data-family-contracts.md');
console.log(`Tables: ${schema.tables.length}`);
console.log(`Columns: ${schema.tables.reduce((sum, t) => sum + t.columns.size, 0)}`);
console.log(`API routes: ${api.routes.length}`);
