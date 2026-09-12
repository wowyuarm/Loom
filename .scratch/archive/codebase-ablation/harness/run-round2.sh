#!/usr/bin/env bash
# Round 2 runner: stub ablation of the six cognitive-organ factories, 2-way parallel.
set -u
cd "$(dirname "$0")/../../../.." || exit 1
REPO="$PWD"
HARNESS=".scratch/archive/codebase-ablation/harness"
OUT=".scratch/archive/codebase-ablation/results"
TARGETS=(
  "agents/orientation.ts createPiOrientation"
  "agents/life-recorder.ts createPiLifeRecorder"
  "agents/thread-maintainer/index.ts createPiThreadMaintainer"
  "agents/attention-maintainer.ts createPiAttentionMaintainer"
  "agents/memory-reflector.ts createPiMemoryReflector"
  "agents/tool-trace-compactor.ts createPiToolTraceCompactor"
)
run_one() {
  local file="$1" fn="$2"
  node "$HARNESS/ablate-stub.mjs" "$REPO" "$file" "$fn" "$OUT/r2__${file//\//__}.json"
}
run_one ${TARGETS[0]} & p1=$!
run_one ${TARGETS[1]} & p2=$!
wait "$p1" "$p2"
run_one ${TARGETS[2]} & p1=$!
run_one ${TARGETS[3]} & p2=$!
wait "$p1" "$p2"
run_one ${TARGETS[4]} & p1=$!
run_one ${TARGETS[5]} & p2=$!
wait "$p1" "$p2"
echo "ROUND2 DONE"
