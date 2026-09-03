// Usage: node merge-coverage.mjs <repoRoot> <workDir> <analysisOutJson>
// Merges the per-run V8 coverage dumps into a test-file -> src-line matrix and
// computes the leave-one-out ablation analytics:
//   - per test file: covered src lines, unique lines (covered by no other file)
//   - fully-subsumed test files (unique == 0): redundancy candidates
//   - per src file: how many test files execute it (guard count)
// Raw matrix goes to <workDir>/matrix.json (not committed); compact analytics
// go to <analysisOutJson>.
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [repoRoot, workDir, analysisOut] = process.argv.slice(2);
const manifestDir = path.join(workDir, "manifest");

const runs = readdirSync(manifestDir).filter(f => f.endsWith(".json")).map(f =>
  JSON.parse(readFileSync(path.join(manifestDir, f), "utf8")));

// --- V8 block coverage -> covered byte intervals -----------------------------
// Covered = union of count>0 ranges minus union of count==0 ranges.  Valid
// because V8 ranges nest properly: a count==0 range can never contain a
// count>0 descendant, so zero-ranges are exact holes in their executed parent.
function coveredIntervals(functions) {
  const pos = [];
  const zero = [];
  const seen = new Set();
  for (const fn of functions) {
    for (const range of fn.ranges) {
      const key = `${range.startOffset}:${range.endOffset}:${range.count}`;
      if (seen.has(key)) continue;
      seen.add(key);
      (range.count > 0 ? pos : zero).push([range.startOffset, range.endOffset]);
    }
  }
  return subtract(merge(pos), merge(zero));
}

function merge(intervals) {
  if (intervals.length === 0) return [];
  intervals.sort((a, b) => a[0] - b[0]);
  const out = [intervals[0].slice()];
  for (const [start, end] of intervals.slice(1)) {
    const last = out[out.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

function subtract(from, remove) {
  const out = [];
  let j = 0;
  for (const [start, end] of from) {
    let cursor = start;
    while (j < remove.length && remove[j][1] <= cursor) j += 1;
    for (let k = j; k < remove.length && remove[k][0] < end; k += 1) {
      const [rStart, rEnd] = remove[k];
      if (rStart > cursor) out.push([cursor, Math.min(rStart, end)]);
      cursor = Math.max(cursor, rEnd);
      if (cursor >= end) break;
    }
    if (cursor < end) out.push([cursor, end]);
  }
  return out;
}

// --- byte offsets -> generated line numbers ----------------------------------
function linesForIntervals(source, intervals) {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }
  const lines = new Set();
  for (const [start, end] of intervals) {
    const first = boundary(lineStarts, start);
    const last = boundary(lineStarts, Math.max(start, end - 1));
    for (let line = first; line <= last; line += 1) lines.add(line + 1);
  }
  return lines;
}

function boundary(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// --- sourcemap: generated line -> original src line ---------------------------
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decodeMappings(mappings) {
  const tables = [];
  let srcIdx = 0, srcLine = 0;
  for (const genLine of mappings.split(";")) {
    let genCol = 0;
    const segments = [];
    for (const segment of genLine.split(",")) {
      if (!segment) continue;
      const fields = [];
      let i = 0;
      while (i < segment.length) {
        let value = 0, shift = 0, cont = 1;
        while (cont) {
          const digit = B64.indexOf(segment[i++]);
          cont = digit & 32;
          value += (digit & 31) << shift;
          shift += 5;
        }
        const negative = value & 1;
        value >>= 1;
        fields.push(negative ? -value : value);
      }
      genCol += fields[0];
      if (fields.length >= 4) {
        srcIdx += fields[1];
        srcLine += fields[2];
        segments.push([genCol, srcIdx, srcLine]);
      }
    }
    tables.push(segments);
  }
  return tables;
}

function srcLineTable(mapPath) {
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const tables = decodeMappings(map.mappings);
  const mapDir = path.dirname(mapPath);
  const sources = map.sources.filter(Boolean).map(source => path.resolve(mapDir, source));
  const table = new Map(); // generated line (1-based) -> { srcPath, line }
  let last;
  for (let line = 1; line <= tables.length; line += 1) {
    const mapped = tables[line - 1].find(segment => segment.length === 3);
    if (mapped) last = mapped;
    if (last) table.set(line, { srcPath: path.relative(repoRoot, sources[last[1]]), line: last[2] + 1 });
  }
  return table;
}

// --- merge all runs ------------------------------------------------------------
const matrix = {}; // test name -> { srcPath -> Set(original lines) }
const unmapped = {}; // test name -> { dist path -> unmapped generated line count }
const distStats = {}; // dist path -> byte size

for (const run of runs) {
  const perFile = {};
  matrix[run.name] = perFile;
  unmapped[run.name] = {};
  for (const entry of readdirSync(run.covDir).filter(f => f.startsWith("coverage-") && f.endsWith(".json"))) {
    const dump = JSON.parse(readFileSync(path.join(run.covDir, entry), "utf8"));
    for (const script of dump.result) {
      if (!script.url) continue;
      let filePath;
      try {
        filePath = fileURLToPath(script.url);
      } catch {
        continue;
      }
      const rel = path.relative(repoRoot, filePath);
      // Compiled src lands in dist/src; plain .mjs scripts under src/ run in
      // place and appear in coverage with their source-tree path.
      const isCompiledSrc = rel.startsWith(`dist${path.sep}src${path.sep}`);
      const isPlainSrcScript = rel.startsWith(`src${path.sep}`) && rel.endsWith(".mjs");
      if (!isCompiledSrc && !isPlainSrcScript) continue;
      const source = readFileSync(filePath, "utf8");
      distStats[rel] = source.length;
      const generatedLines = linesForIntervals(source, coveredIntervals(script.functions));
      const mapPath = `${filePath}.map`;
      if (isPlainSrcScript) {
        // No build step: generated lines are the src lines.
        for (const line of generatedLines) (perFile[rel] ??= new Set()).add(line);
        continue;
      }
      if (!existsSync(mapPath)) {
        unmapped[run.name][rel] = generatedLines.size;
        continue;
      }
      const table = srcLineTable(mapPath);
      for (const line of generatedLines) {
        const mapped = table.get(line);
        if (!mapped || !mapped.srcPath.startsWith(`src${path.sep}`)) {
          unmapped[run.name][rel] = (unmapped[run.name][rel] ?? 0) + 1;
          continue;
        }
        (perFile[mapped.srcPath] ??= new Set()).add(mapped.line);
      }
    }
  }
}

// --- analytics ------------------------------------------------------------------
const names = Object.keys(matrix);

// line -> number of test files covering it, computed in one pass
const coverCount = {}; // srcPath -> Map(line -> count)
for (const name of names) {
  for (const [srcPath, lines] of Object.entries(matrix[name])) {
    const counts = (coverCount[srcPath] ??= new Map());
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
}
const allCovered = {}; // srcPath -> union of covered lines
for (const [srcPath, counts] of Object.entries(coverCount)) allCovered[srcPath] = new Set(counts.keys());

const perTest = names.map(name => {
  let covered = 0;
  const uniqueByFile = {};
  for (const [srcPath, lines] of Object.entries(matrix[name])) {
    covered += lines.size;
    const counts = coverCount[srcPath];
    const unique = [...lines].filter(line => counts.get(line) === 1);
    if (unique.length > 0) uniqueByFile[srcPath] = unique.length;
  }
  const uniqueTotal = Object.values(uniqueByFile).reduce((a, b) => a + b, 0);
  const run = runs.find(candidate => candidate.name === name);
  return {
    name,
    file: run.file,
    tests: run.tests ?? null,
    pass: run.pass ?? null,
    fail: run.fail ?? null,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    srcFilesCovered: Object.keys(matrix[name]).length,
    coveredLines: covered,
    uniqueLines: uniqueTotal,
    uniqueRatio: covered === 0 ? 0 : Number((uniqueTotal / covered).toFixed(4)),
    uniqueTop: Object.fromEntries(Object.entries(uniqueByFile).sort((a, b) => b[1] - a[1]).slice(0, 8)),
  };
}).sort((a, b) => b.uniqueRatio - a.uniqueRatio || b.coveredLines - a.coveredLines);

const perSrcFile = Object.keys(allCovered).map(srcPath => ({
  srcPath,
  guards: names.filter(name => matrix[name][srcPath]).length,
  coveredLines: allCovered[srcPath].size,
})).sort((a, b) => a.guards - b.guards || a.srcPath.localeCompare(b.srcPath));

const srcInventory = execSync("git ls-files 'src/**/*.ts'", { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
const zeroCoverage = srcInventory.filter(srcPath => !allCovered[srcPath]).map(srcPath => {
  const distPath = path.join(repoRoot, "dist", srcPath.replace(/^src[/\\]/, "").replace(/\.ts$/, ".js"));
  return {
    srcPath,
    distExists: existsSync(distPath),
    distBytes: existsSync(distPath) ? statSync(distPath).size : 0,
  };
});

const analysis = {
  generatedAt: new Date().toISOString(),
  runs: runs.length,
  perTest,
  perSrcFile,
  zeroCoverage,
  unmapped: Object.fromEntries(Object.entries(unmapped).filter(([, files]) => Object.keys(files).length > 0)),
};

writeFileSync(analysisOut, JSON.stringify(analysis, null, 2));
writeFileSync(path.join(workDir, "matrix.json"), JSON.stringify(Object.fromEntries(
  Object.entries(matrix).map(([name, files]) => [name, Object.fromEntries(
    Object.entries(files).map(([srcPath, lines]) => [srcPath, [...lines].sort((a, b) => a - b)]),
  )]),
)));

console.log(`runs: ${runs.length}`);
console.log(`fully subsumed (unique == 0): ${perTest.filter(t => t.uniqueLines === 0).map(t => t.name).join(", ") || "none"}`);
console.log(`src files zero-covered: ${zeroCoverage.length}`);
