#!/bin/sh
# Build everything for this checkout in one shot:
#   1. fetch the released pi_natives addons from npm (skips when the pinned
#      version's addons are already in packages/natives/native)
#   2. build the omp binary (packages/coding-agent/dist/omp)
#   3. deploy the collab relay worker (collab-web build + wrangler deploy)
#
# Each step runs from the repo root, so this script works from any cwd.
set -e
cd "$(dirname "$0")"

echo "==> natives:fetch"
bun run natives:fetch

echo "==> omp build"
bun --cwd=packages/coding-agent run build

echo "==> collab worker deploy"
bun run collab:worker:deploy

echo "==> done"