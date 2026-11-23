#!/usr/bin/env bash
# Deploy Mimir's Gno packages, in dependency order, with gnokey.
#
#   KEY=mimir-deployer CHAIN_ID=onyx-1 REMOTE=https://rpc.onyx.testnets.gno.land:443 scripts/gno/deploy.sh [pkg...]
#
# The key must own the namespace: the packages live under gno.land/{p,r}/<deployer address>/.
# With no arguments every package is deployed; name some (e.g. r/pool) to deploy only those.
# Reads the key password from stdin when PASSWORD_FILE is set.
set -euo pipefail

KEY=${KEY:-mimir-deployer}
CHAIN_ID=${CHAIN_ID:-onyx-1}
REMOTE=${REMOTE:-https://rpc.onyx.testnets.gno.land:443}
NS=${NS:-g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz}
GAS_WANTED=${GAS_WANTED:-80000000}
GAS_FEE=${GAS_FEE:-100000ugnot}
MAX_DEPOSIT=${MAX_DEPOSIT:-500000000ugnot}
ROOT=$(cd "$(dirname "$0")/../../gno" && pwd)

PKGS=("$@")
[ ${#PKGS[@]} -eq 0 ] && PKGS=(p/mimir r/musd r/fees r/pool r/vs r/agentpay)

for pkg in "${PKGS[@]}"; do
  kind=${pkg%%/*}
  name=${pkg#*/}
  path="gno.land/$kind/$NS/$name"
  echo "==> $path"
  args=(maketx addpkg -pkgpath "$path" -pkgdir "$ROOT/$pkg"
    -gas-fee "$GAS_FEE" -gas-wanted "$GAS_WANTED" -max-deposit "$MAX_DEPOSIT"
    -broadcast -chainid "$CHAIN_ID" -remote "$REMOTE")
  if [ -n "${PASSWORD_FILE:-}" ]; then
    gnokey "${args[@]}" -insecure-password-stdin "$KEY" < "$PASSWORD_FILE"
  else
    gnokey "${args[@]}" "$KEY"
  fi
done
