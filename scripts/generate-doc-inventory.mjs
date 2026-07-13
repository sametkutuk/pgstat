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

  function refsFor(fileName) {
    const file = javaFiles.find((f) => path.basename(f) === fileName);
    return file ? extractTableRefs(readText(file)) : [];
  }

  return {
    sourceFamilies,
    tableRefsByFile,
    purgeRefs: refsFor('PurgeEvaluator.java'),
    partitionRefs: refsFor('PartitionManager.java'),
    aggRefs: refsFor('AggRepository.java'),
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

console.log('Generated docs/generated/project-inventory.md');
console.log(`Tables: ${schema.tables.length}`);
console.log(`Columns: ${schema.tables.reduce((sum, t) => sum + t.columns.size, 0)}`);
console.log(`API routes: ${api.routes.length}`);
