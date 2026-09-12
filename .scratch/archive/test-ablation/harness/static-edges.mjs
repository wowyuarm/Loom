// Extract static runtime import edges from compiled test files: dist/test/*.js
// -> src files.  Usage: node static-edges.mjs <repoRoot> <outJson>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [repoRoot, outJson] = process.argv.slice(2);
process.chdir(repoRoot);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const child = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(child) : [child];
  });
}

const edges = {};
for (const file of walk("dist/test").filter(f => f.endsWith(".js") && f.endsWith(".test.js"))) {
  const source = readFileSync(file, "utf8");
  const specs = [...source.matchAll(/from\s+"(\.[^"]+)"/g)].map(match => match[1]);
  const deps = new Set();
  for (const spec of specs) {
    // Compiled test files live under dist/test/, so "../../src/x.js" resolves to
// dist/src/x.js — map that back to the src tree.
const rel = path.relative(repoRoot, path.resolve(path.dirname(file), spec))
  .replace(/^dist[/\\]src[/\\]/, "src/")
  .replace(/\.js$/, ".ts");
    if (rel.startsWith("src/")) deps.add(rel);
  }
  if (deps.size > 0) edges[path.relative("dist/test", file).replace(/\.test\.js$/, "")] = [...deps].sort();
}

writeFileSync(outJson, JSON.stringify(edges, null, 2));
const counts = Object.entries(edges).map(([test, deps]) => [test, deps.length]).sort((a, b) => b[1] - a[1]);
console.log(`test files with src deps: ${counts.length}`);
console.log(counts.slice(0, 10).map(([test, count]) => `${test}: ${count}`).join("\n"));
