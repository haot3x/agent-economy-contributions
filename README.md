# Agent Economy Contributions

Maintainer: Ted (@haot3x)

Small, reproducible application fixtures and pinned upstream test runs for Ethereum agent-economy discussions.

| Directory | What it contains | Current local result |
| --- | --- | --- |
| [eip-8304](./eip-8304/) | My normalized log consumer: wallet changes, pagination, retries, and whole-block soft-cap handling | 32 Python tests pass |
| [erc-8470](./erc-8470/) | Toll's unmodified registry and suite at `0d6a107`, plus a local liquidity reader and regression cases | 47 upstream + 12 consumer tests pass |

The EIP-8304 fixture checks application bookkeeping, not proof validity or a live RPC. The ERC-8470 directory reproduces the author's mocked tests and adds a narrow local reader. This is not an independent registry implementation, live-chain validation, or security audit. Proposal numbers do not imply Final status.

## Run

Requirements: Python 3 and Foundry v1.7.1. Solidity 0.8.26, Cancun, and optimizer runs 200 are fixed in the ERC-8470 configuration. No Python packages or Solidity libraries are needed. Forge downloads the configured compiler if it is not cached.

```sh
bash scripts/check.sh
```

If Forge is outside `PATH`:

```sh
FORGE_BIN=/absolute/path/to/forge bash scripts/check.sh
```

The script checks the four vendored upstream files against their SHA-256 manifest, checks the local Solidity formatting, then runs all **91 tests**. GitHub Actions runs the same command.

## Discussion and provenance

| Topic | URL |
| --- | --- |
| EIP-8304 discussion and consumer fixture | https://ethereum-magicians.org/t/eip-8304-trustless-log-and-transaction-index/28824/12 |
| Original EIP-8304 fixture Gist | https://gist.github.com/haot3x/fea27ad519804571e92c95609516903a |
| ERC-8470 suggestion and author's response | https://ethereum-magicians.org/t/erc-8470-launch-observations/30112/7 |
| ERC-8470 upstream PR | https://github.com/ethereum/ERCs/pull/2121 |

See [the 1 November update](./reports/2026-11-01.md), [the earlier review](./reports/2026-10-30.md), [EIP-8304 scope](./eip-8304/README.md), [ERC-8470 provenance](./erc-8470/UPSTREAM.md), and [the reader's boundaries](./erc-8470/consumer/README.md). Gist revision `29737bdda9257dc3d4d779d6c345e736136b1774` is the source of the two Python files; the same bytes are included here.

## License

CC0-1.0; see [LICENSE.md](./LICENSE.md). The vendored ERC-8470 contracts and upstream tests are by Toll (@soli0x), retained unchanged with their original SPDX notices. Ted authored the EIP-8304 fixtures, local ERC-8470 reader and consumer tests, and reproduction setup.
