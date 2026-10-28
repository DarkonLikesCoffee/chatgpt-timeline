// Static checks for the unpacked extension (there is no bundling step):
// - manifest.json is valid MV3 and every file it references exists
// - every JavaScript file parses
// - every module the content script imports is web-accessible on chatgpt.com
//   (content scripts load their ES modules through web_accessible_resources)
// - extension pages' module imports resolve to existing files
// - no Chrome permissions beyond the expected (none)
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const fail = (m) => errors.push(m);
const rel = (p) => relative(ROOT, p).split('\\').join('/');

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
const ALLOWED_PERMISSIONS = [];
for (const p of [...(manifest.permissions || []), ...(manifest.host_permissions || [])]) {
  if (!ALLOWED_PERMISSIONS.includes(p)) fail(`unexpected permission: ${p}`);
}

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...manifest.content_scripts.flatMap((c) => c.js || []),
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action.default_icon || {}),
];
for (const f of referenced) if (!existsSync(join(ROOT, f))) fail(`manifest references missing file ${f}`);

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const jsFiles = walk(join(ROOT, 'src')).filter((f) => f.endsWith('.js'));
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    fail(`syntax error in ${rel(f)}: ${e.stderr}`);
  }
}

const IMPORT = /(?:^|\n)\s*import\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*chrome\.runtime\.getURL\(['"]([^'"]+)['"]\)\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(IMPORT)) {
    if (m[1] || m[3]) out.push(resolve(dirname(file), m[1] || m[3]));
    if (m[2]) out.push(join(ROOT, m[2]));
  }
  return out;
}
function graph(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!existsSync(f)) {
      fail(`import of missing module ${rel(f)}`);
      continue;
    }
    stack.push(...importsOf(f));
  }
  return seen;
}

const war = (manifest.web_accessible_resources || []).flatMap((w) => w.resources);
const globToRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
for (const cs of manifest.content_scripts) {
  for (const entry of cs.js) {
    for (const f of graph(join(ROOT, entry))) {
      const r = rel(f);
      if (r === entry) continue;
      if (!war.some((g) => globToRe(g).test(r))) fail(`content-script module ${r} is not in web_accessible_resources`);
    }
  }
}

graph(join(ROOT, manifest.background.service_worker));
for (const html of walk(join(ROOT, 'src')).filter((f) => f.endsWith('.html'))) {
  const src = readFileSync(html, 'utf8');
  for (const m of src.matchAll(/<(?:script[^>]*src|link[^>]*href)="([^"]+)"/g)) {
    const target = resolve(dirname(html), m[1]);
    if (!existsSync(target)) fail(`${rel(html)} references missing ${m[1]}`);
    else if (target.endsWith('.js')) graph(target);
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>/.test(src)) fail(`${rel(html)} has an inline script (blocked by extension CSP)`);
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'));
  process.exit(1);
}
console.log(`✓ manifest valid, ${referenced.length} referenced files present, ${jsFiles.length} JS files parse, content-script modules web-accessible, no extra permissions`);
