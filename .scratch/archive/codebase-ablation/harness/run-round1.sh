#!/usr/bin/env bash
# Round 1 runner: deletion ablation over modules + hot files, 2-way parallel.
set -u
cd "$(dirname "$0")/../../../.." || exit 1
REPO="$PWD"
HARNESS=".scratch/archive/codebase-ablation/harness"
OUT=".scratch/archive/codebase-ablation/results"
TARGETS=(
  configuration runtime workspace attachments
  channels channels/raft channels/weixin
  agents main-agent
  integrations integrations/nmem integrations/web
  instance host
  operational-events.ts continuity-guidance.ts
)
run_two() {
  local a="$1" b="$2"
  node "$HARNESS/ablate-delete.mjs" "$REPO" "$a" "$OUT/r1__${a//\//__}.json" &
  local p1=$!
  if [ -n "$b" ]; then
    node "$HARNESS/ablate-delete.mjs" "$REPO" "$b" "$OUT/r1__${b//\//__}.json" &
    local p2=$!
    wait "$p2"
  fi
  wait "$p1"
}
n=${#TARGETS[@]}
for ((i = 0; i < n; i += 2)); do
  run_two "${TARGETS[i]}" "${TARGETS[i + 1]:-}"
done
echo "ROUND1 DONE"
