#!/bin/sh
# Full round: one coverage-instrumented run per test file, then merge + analytics.
# Usage: run-round.sh <repoRoot> <workDir> <analysisOutJson>
# 2-way parallel: same file-process isolation as the default suite (node --test
# spawns one process per file), light enough for a 4-core box.
set -e
repo="$1"
work="$2"
out="$3"
mkdir -p "$work/coverage" "$work/manifest"
cd "$repo"
find dist/test -name '*.test.js' | sort | xargs -P 2 -n 1 node "$repo/.scratch/test-ablation/harness/collect-one.mjs" "$repo" "$work"
node "$repo/.scratch/test-ablation/harness/merge-coverage.mjs" "$repo" "$work" "$out"
