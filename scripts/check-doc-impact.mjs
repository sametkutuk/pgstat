import { execSync } from 'node:child_process';

function run(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const args = {
    staged: argv.includes('--staged'),
    base: null,
  };
  for (const arg of argv) {
    if (arg.startsWith('--base=')) args.base = arg.slice('--base='.length);
  }
  return args;
}

function unique(items) {
  return [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function changedFiles(args) {
  if (args.staged) {
    return unique(run('git diff --cached --name-only').split(/\r?\n/));
  }
  if (args.base) {
    return unique(run(`git diff --name-only ${args.base}...HEAD`).split(/\r?\n/));
  }
  return unique([
    ...run('git diff --name-only').split(/\r?\n/),
    ...run('git diff --cached --name-only').split(/\r?\n/),
  ]);
}

function matchesAny(file, patterns) {
  return patterns.some((pattern) => pattern.test(file));
}

const GENERATED_DOCS = [
  'docs/generated/project-inventory.md',
  'docs/generated/data-lifecycle-matrix.md',
  'docs/generated/data-family-contracts.md',
  'docs/generated/field-contracts.md',
  'docs/generated/contract-review-queue.md',
  'docs/generated/project-status.md',
];

const MANUAL_CONTRACT_DOCS = [
  /^docs\/project-master\.md$/,
  /^docs\/project-execution-plan\.md$/,
  /^docs\/project-board\.json$/,
  /^docs\/pgstat-data-source-dictionary\.md$/,
  /^docs\/data-contract-registry\.md$/,
  /^docs\/pgstat-telemetry-completion-roadmap\.md$/,
  /^docs\/pgdbaagent-contracts\.md$/,
  /^docs\/agentic-dba-platform-architecture\.md$/,
  /^docs\/platform-governance-and-sdlc\.md$/,
  /^docs\/pg-stat-views-matrix\.md$/,
  /^docs\/work-orders\/.*\.md$/,
];

const CRITICAL_GROUPS = [
  {
    name: 'schema/migration',
    patterns: [/^db\/migrations\/.*\.sql$/],
    generatedRequired: true,
    manualRequired: true,
  },
  {
    name: 'collector/source',
    patterns: [
      /^collector\/src\/main\/java\/com\/pgstat\/collector\/sql\/.*\.java$/,
      /^collector\/src\/main\/java\/com\/pgstat\/collector\/collector\/.*\.java$/,
      /^collector\/src\/main\/java\/com\/pgstat\/collector\/repository\/.*\.java$/,
      /^collector\/src\/main\/java\/com\/pgstat\/collector\/service\/(PurgeEvaluator|PartitionManager|AggRepository|BaselineCalculator|AlertRuleEvaluator|ReportGenerator).*\.java$/,
    ],
    generatedRequired: true,
    manualRequired: true,
  },
  {
    name: 'api/routes',
    patterns: [/^api\/src\/routes\/.*\.ts$/],
    generatedRequired: true,
    manualRequired: true,
  },
  {
    name: 'ui/insights-or-pages',
    patterns: [/^ui\/src\/pages\/.*\.(ts|tsx)$/, /^ui\/src\/components\/.*\.(ts|tsx)$/],
    generatedRequired: true,
    manualRequired: false,
  },
  {
    name: 'pgdbaagent-contract',
    patterns: [/^pgdbaagent\//, /^agent\//, /^docs\/pgdbaagent-contracts\.md$/],
    generatedRequired: false,
    manualRequired: true,
  },
  {
    name: 'project-board',
    patterns: [/^docs\/project-board\.json$/],
    generatedRequired: false,
    manualRequired: false,
  },
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = changedFiles(args).map((file) => file.replace(/\\/g, '/'));
  if (!files.length) {
    console.log('docs-impact: no changed files');
    return;
  }

  const changedGeneratedDocs = GENERATED_DOCS.filter((doc) => files.includes(doc));
  const changedManualDocs = files.filter((file) => matchesAny(file, MANUAL_CONTRACT_DOCS));
  const failures = [];
  const impacted = [];

  // generatedRequired sadece "bu commit'te generated docs degisti mi" degil,
  // "generated docs SU AN (HEAD'e gore) guncel mi" sorusunu sormali — kod
  // degisikligi inventory'nin (tablo/kolon/route sayimi) icerigini
  // etkilemiyorsa generate script'i calistirmak dosyada fark uretmez, bu
  // durum bir eksiklik degildir. pre-commit hook generate script'ini
  // calistirip sonucu stage ettikten SONRA bu script'i cagirdigi icin,
  // HEAD ile working tree arasinda fark yoksa dosyalarin zaten guncel
  // oldugu kabul edilir (bu script generate etmez, sadece raporlar).
  const generatedDocsUpToDate = !GENERATED_DOCS.some((doc) => run(`git diff HEAD --name-only -- ${doc}`).trim());

  for (const group of CRITICAL_GROUPS) {
    const groupFiles = files.filter((file) => matchesAny(file, group.patterns));
    if (!groupFiles.length) continue;
    impacted.push(`${group.name}: ${groupFiles.length} file(s)`);
    if (group.generatedRequired && !changedGeneratedDocs.length && !generatedDocsUpToDate) {
      failures.push(`${group.name} changed but generated docs were not updated. Run: node scripts/generate-doc-inventory.mjs`);
    }
    if (group.manualRequired && !changedManualDocs.length) {
      failures.push(`${group.name} changed but no manual contract/governance doc changed.`);
    }
  }

  if (!impacted.length) {
    console.log('docs-impact: no critical documentation impact detected');
    return;
  }

  console.log(`docs-impact: impacted groups: ${impacted.join('; ')}`);
  console.log(`docs-impact: generated docs changed: ${changedGeneratedDocs.join(', ') || 'none'}`);
  console.log(`docs-impact: manual docs changed: ${changedManualDocs.join(', ') || 'none'}`);

  if (failures.length) {
    console.error('docs-impact: failed');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('docs-impact: passed');
}

main();
