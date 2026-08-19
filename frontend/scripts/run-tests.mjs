/**
 * Test runner.
 *
 * Plain .test.js files run directly on Node's built-in runner. The .test.jsx
 * ones need transpiling first, which esbuild (already present as a Vite
 * dependency) does in a few milliseconds - no extra test framework, no jsdom.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src');
const outDir = path.join(root, 'node_modules', '.test-build');

const find = (dir, suffix) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return find(full, suffix);
    return entry.name.endsWith(suffix) ? [full] : [];
  });

const plain = find(source, '.test.js');
const jsx = find(source, '.test.jsx');

let built = [];
if (jsx.length) {
  fs.rmSync(outDir, { recursive: true, force: true });
  await esbuild.build({
    entryPoints: jsx,
    outdir: outDir,
    outbase: source,
    // Relative imports (the components under test) are pulled in and compiled;
    // packages stay external so React resolves from node_modules as usual.
    bundle: true,
    packages: 'external',
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    logLevel: 'error',
  });

  built = jsx.map((file) =>
    path.join(outDir, path.relative(source, file)).replace(/\.jsx$/, '.js'),
  );
}

const files = [...plain, ...built];
if (!files.length) {
  console.log('no tests found');
  process.exit(0);
}

try {
  execFileSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
} catch {
  process.exit(1);
}
