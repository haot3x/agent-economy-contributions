# ERC-8470 upstream reproduction

Upstream author: Toll (@soli0x). Reproduction: Ted (@haot3x), updated 2026-11-01.

- Repository: https://github.com/soli0x/ERCs
- PR: https://github.com/ethereum/ERCs/pull/2121
- Commit: `0d6a107df44dd632523b56f568633f096abde6e0`
- Source directory: https://github.com/soli0x/ERCs/tree/0d6a107df44dd632523b56f568633f096abde6e0/assets/erc-8470
- Specification: https://github.com/soli0x/ERCs/blob/0d6a107df44dd632523b56f568633f096abde6e0/ERCS/erc-8470.md
- License: CC0-1.0, as stated in every source file.

Four files are copied byte-for-byte, with paths preserved below this directory:

```text
contracts/ILaunchObservations.sol
contracts/LaunchObservations.sol
test/LaunchObservations.t.sol
test/Mocks.sol
```

`SHA256SUMS` fixes those bytes. All four still match the earlier `a7c640b` source byte-for-byte: the intervening three commits change only the specification. `foundry.toml`, this note, `consumer/`, `test/ConsumerPolicy.t.sol`, and the repository-level check script are local additions. No upstream source or test was edited.

## Result and changes since the previous reproduction

Native Forge v1.7.1, solc 0.8.26, Cancun, optimizer runs 200: **47 upstream and 12 local consumer tests pass**. The previous reproduction at `a7c640b` passed the same 47 upstream tests; the earlier `4d09913` reproduction passed 45.

The new local cases exercise the revised specification: not-read cannot satisfy a minimum, publication time cannot refresh old source data, and an unauthenticated cross-chain reading is unsupported. See [the consumer note](./consumer/README.md).

The current revision stores and emits `hashChecked`. It is true only when the registry read a matching hash on its own chain. It remains false for observations of another chain or when no hash can be read. Strict readers can inspect the stored flag and refuse unchecked observations.

The registry now asks the history contract without assuming an 8,191-block maximum. Mocked Arbitrum cases exercise a readable hash 300,000 blocks deep and an unavailable hash, including mismatch rejection. Other new cases cover the optional text-flags finding. The public report's measured Robinhood Chain history window was supplied by the author; this reproduction does not independently measure it.

This run uses ArbSys/history mocks. The local reader checks one liquidity minimum; it is not a complete trading guard. No contracts are deployed and no live chain is queried. The tests do not prove finality or validate detector findings. A true `hashChecked` describes a check at recording time; it is not a timeless guarantee against later reorganizations or a token safety verdict.
