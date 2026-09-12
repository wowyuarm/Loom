// Static import graph over src/ and test/ for Loom ablation experiments.
// Only relative imports matter; package imports are ignored.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

export function listTsFiles(rootDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(rootDir);
  return out;
}

function resolveImport(fromFile, spec, rootDir) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ".ts"));
  if (statSyncSafe(base)) return base;
  const asIndex = path.join(base, "index.ts");
  if (statSyncSafe(asIndex)) return asIndex;
  return null;
}

function statSyncSafe(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// Returns { files: Map<absPath, string[] deps>, roots: { src, test } }
export function buildGraph(rootDir) {
  rootDir = path.resolve(rootDir);
  const srcRoot = path.join(rootDir, "src");
  const testRoot = path.join(rootDir, "test");
  const files = new Map(); // abs -> deps[]
  const add = (abs) => {
    if (!existsSync(abs)) return;
    const text = readFileSync(abs, "utf8");
    const specs = [];
    for (const m of text.matchAll(/from\s*["']([^"']+)["']/g)) specs.push(m[1]);
    for (const m of text.matchAll(/import\s*["']([^"']+)["']/g)) specs.push(m[1]);
    for (const m of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
    const deps = [];
    for (const spec of specs) {
      const resolved = resolveImport(abs, spec, rootDir);
      if (resolved) deps.push(resolved);
    }
    files.set(abs, deps);
  };
  for (const f of listTsFiles(srcRoot)) add(f);
  if (existsSync(testRoot)) for (const f of listTsFiles(testRoot)) add(f);
  return { files, rootDir };
}

// All files (src or test) that transitively import anything in `targets`.
export function reverseClosure(graph, targets) {
  const targetSet = new Set(targets);
  const importers = new Map(); // dep -> [importers]
  for (const [file, deps] of graph.files) {
    for (const dep of deps) {
      if (!importers.has(dep)) importers.set(dep, []);
      importers.get(dep).push(file);
    }
  }
  const removed = new Set(targetSet);
  const queue = [...targetSet];
  while (queue.length > 0) {
    const cur = queue.pop();
    for (const imp of importers.get(cur) ?? []) {
      if (!removed.has(imp)) {
        removed.add(imp);
        queue.push(imp);
      }
    }
  }
  return [...removed].sort();
}
