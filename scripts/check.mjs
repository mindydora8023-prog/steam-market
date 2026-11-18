import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const roots = ['app', 'lib', 'test', 'scripts'];
const files = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(mjs|js|cjs)$/.test(entry.name)) files.push(full);
  }
}

for (const name of roots) walk(path.join(root, name));

const errors = [];
for (const file of files) {
  const relative = path.relative(root, file);
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    for (let column = 0; column < line.length; column++) {
      const code = line.charCodeAt(column);
      if (code > 127) {
        errors.push(
          `${relative}:${lineIndex + 1}:${column + 1}: non-ASCII U+${code
            .toString(16)
            .toUpperCase()
            .padStart(4, '0')}`,
        );
        break;
      }
    }
  }
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString('utf8').trim() : err.message;
    errors.push(`${relative}: syntax check failed: ${detail}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  console.error(`FAILED: ${errors.length} problem(s) in ${files.length} file(s)`);
  process.exit(1);
}

console.log(`OK: ${files.length} files are ASCII-only and pass node --check`);