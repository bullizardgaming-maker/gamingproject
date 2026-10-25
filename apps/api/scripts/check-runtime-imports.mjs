// Checks that every package the built API imports resolves in this install. Run from apps/api after
// `npm run build` in a production install (`npm prune --omit=dev`, or inside the Docker image): a package that
// is only a devDependency, or left out of the image, fails here instead of crashing the server on start.
//   node scripts/check-runtime-imports.mjs [distDir]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

const dist = path.resolve(process.argv[2] ?? 'dist');
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
};
walk(dist);

const pkgName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
const builtins = new Set(builtinModules);
const specs = new Map(); // specifier -> first file importing it
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  // tsc writes each import/export on one line; dynamic imports are import('x').
  const re = /^\s*(?:import\s+(?:type\s+)?(?:[\w$*{},\s]+?\s+from\s+)?|export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+)['"]([^'"\n]+)['"]|\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/gm;
  for (const m of src.matchAll(re)) {
    const spec = m[1] ?? m[2];
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || builtins.has(pkgName(spec))) continue;
    if (!specs.has(spec)) specs.set(spec, path.relative(dist, file));
  }
}

// The resolver looks in apps/api/node_modules then the root node_modules, the same lookup as dist/.
const failures = [];
for (const [spec, file] of specs) {
  try {
    import.meta.resolve(spec);
  } catch (err) {
    failures.push(`${spec} (imported by ${file}): ${err.code ?? err.message}`);
  }
}
if (failures.length) {
  console.error(`Runtime imports that do not resolve in this install:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log(`runtime imports ok: ${specs.size} package specifier(s) across ${files.length} file(s)`);
