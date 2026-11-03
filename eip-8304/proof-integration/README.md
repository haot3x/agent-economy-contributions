# Proof-to-income integration

Author: Ted (@haot3x)

This harness connects the real Go query prover/verifier to the existing Python
income consumer. It pins Vansh Sahay's EIP-8304 branch at
`07dafeee173c2960a2ab7ba759801ed712d85140`; it does not change the upstream node.

From this directory, with Go 1.27, Python 3 and a C compiler available:

```sh
go test -v .
```

The first run downloads the pinned Go module and its dependencies. `go.sum`
records their checksums. No RPC URL, wallet, chain transaction or deployed
contract is needed. The index contract runs inside a generated in-memory chain.

Validated locally with Go 1.27.3: both top-level tests and all seven subcases pass.
The existing 32 Python tests also pass. The repository workflow runs this harness
in a separate job so Go dependency installation does not affect the other fixtures.

## What crosses the verification boundary

The fixture creates six real EVM logs in two blocks and one further block to
publish the final queried index root. Each three-byte test record encodes a
receipt or wallet change; these are synthetic events, not ERC-20/ERC-8004 ABIs.

The Go matcher constructs a proof, the test serializes and decodes it, and
`QueryProof.Verify` checks it against an independently supplied generated-chain
header, the caller's query, and the default index-contract code allowlist. Only
the verifier's reconstructed logs and proven range reach `consume_verified.py`.
The unverified log list returned alongside the proof is ignored.

The Python bridge imports the existing, unchanged `LatestIncomeWindow`. Starting
with independently known wallet A, it replays wallet changes and receipts in
chain order. The expected result is six unique events and income **25**:
`7 + 13 + 5`. Using the final wallet for all historical receipts would yield 68.

Three positive cases exercise a full query, latest-first overlapping/retried
pages, and a count-capped page followed by boundary-block refill. The consumer
must remain incomplete until its full window is covered. This pinned verifier
supports hard count limits; this test does not turn that into the proposed
whole-block soft-cap RPC policy. Cursor requests are deliberately excluded from
this normalization helper.

Four negative cases reject a mismatched trusted header, changed query limit,
corrupted receipt proof, and omission of the receipt carrying the 13-unit
payment. None is forwarded to accounting. The existing standalone Python tests
still demonstrate that accounting alone cannot detect a missing event.

## Scope

- This tests public Go APIs and proof serialization, not a live JSON-RPC endpoint.
- The opening wallet and trusted header are fixture inputs. Production callers
  must establish identity state, canonicality/finality and the intended event
  filter independently.
- The Python bridge accepts only local test-process output. It is not a service
  that authenticates arbitrary JSON or a substitute for `QueryProof.Verify`.
- The generated-chain proof is not a Willow merged-root or zkVM proof. The
  historical-contract/mainnet-data interoperability test remains separate work.
- New harness files are CC0-1.0. The imported Go implementation retains its
  upstream licenses. This contribution neither modifies nor vendors its source.

Upstream API and test references:

- https://github.com/VanshSahay/go-ethereum/tree/07dafeee173c2960a2ab7ba759801ed712d85140/core/logindex/logquery
- https://ethereum-magicians.org/t/eip-8304-trustless-log-and-transaction-index/28824/15
