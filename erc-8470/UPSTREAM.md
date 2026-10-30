# ERC-8470 upstream reproduction

Upstream author: Toll (@soli0x). Reproduction: Ted (@haot3x), 2026-10-30.

- Repository: https://github.com/soli0x/ERCs
- PR: https://github.com/ethereum/ERCs/pull/2121
- Commit: `a7c640b82d01534750dd30b584bcba2a4a6b6d0c`
- Source directory: https://github.com/soli0x/ERCs/tree/a7c640b82d01534750dd30b584bcba2a4a6b6d0c/assets/erc-8470
- Specification: https://github.com/soli0x/ERCs/blob/a7c640b82d01534750dd30b584bcba2a4a6b6d0c/ERCS/erc-8470.md
- License: CC0-1.0, as stated in every source file.

Four files are copied byte-for-byte, with paths preserved below this directory:

```text
contracts/ILaunchObservations.sol
contracts/LaunchObservations.sol
test/LaunchObservations.t.sol
test/Mocks.sol
```

`SHA256SUMS` fixes those bytes. `foundry.toml`, this note, and the repository-level check script are local reproduction files. No upstream source or test was edited.

## Result and changes since the previous reproduction

Native Forge v1.7.1, solc 0.8.26, Cancun, optimizer runs 200: **47 passed, 0 failed, 0 skipped**. The previous reproduction at `4d0991385066478214662fb0b3ad2570459c2a33` passed 45 tests.

The current revision stores and emits `hashChecked`. It is true only when the registry read a matching hash on its own chain. It remains false for observations of another chain or when no hash can be read. Strict readers can inspect the stored flag and refuse unchecked observations.

The registry now asks the history contract without assuming an 8,191-block maximum. Mocked Arbitrum cases exercise a readable hash 300,000 blocks deep and an unavailable hash, including mismatch rejection. Other new cases cover the optional text-flags finding. The public report's measured Robinhood Chain history window was supplied by the author; this reproduction does not independently measure it.

This run covers the upstream suite with ArbSys/history mocks. It does not deploy contracts, query a live chain, implement a strict trading guard, prove finality, or validate the truth of detector findings. A true `hashChecked` describes a check at recording time; it is not a timeless guarantee against later reorganizations or a token safety verdict.
