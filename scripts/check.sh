#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
forge_bin="${FORGE_BIN:-forge}"

cd "$repo_root"
python3 - <<'PY'
import hashlib
from pathlib import Path

base = Path('erc-8470')
entries = (base / 'SHA256SUMS').read_text().splitlines()
expected_files = {
    'contracts/ILaunchObservations.sol',
    'contracts/LaunchObservations.sol',
    'test/LaunchObservations.t.sol',
    'test/Mocks.sol',
}
seen = set()
for line in entries:
    expected, name = line.split('  ', 1)
    if name not in expected_files or name in seen:
        raise SystemExit(f'Unexpected or duplicate manifest entry: {name}')
    actual = hashlib.sha256((base / name).read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f'Upstream file changed: {name}')
    seen.add(name)
if seen != expected_files:
    raise SystemExit('Upstream manifest is incomplete')
print('Verified four pinned upstream files.', flush=True)
PY

(
    cd eip-8304
    python3 -B -m unittest -v log_pages reverse_log_pages
)
(
    cd erc-8470
    "$forge_bin" test -vv
)
