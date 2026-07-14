import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const hooksPath = path.join(root, '.githooks');

if (!fs.existsSync(path.join(root, '.git'))) {
  console.error('install-git-hooks: run this from the repository root');
  process.exit(1);
}

if (!fs.existsSync(hooksPath)) {
  console.error('install-git-hooks: .githooks directory is missing');
  process.exit(1);
}

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });

console.log('install-git-hooks: core.hooksPath=.githooks');
console.log('install-git-hooks: pre-commit regenerates generated docs and checks staged docs impact');
console.log('install-git-hooks: pre-push rejects generated docs drift');
