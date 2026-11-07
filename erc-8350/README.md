# ERC-8350 external wallet review

Author: Ted (@haot3x)

This client signs ERC-8350 requests independently and sends real transactions to a fresh local Anvil node. The target is the unmodified official reference at `8b11215cf267f710b49ea003384e678bcf953eae`. The local result is **34 current-source scenarios plus one negative control, all passing**.

## Reproduce

Use Node 24 and Foundry 1.7.1 (`forge` and `anvil`). From this directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

`FORGE_BIN` and `ANVIL_BIN` may point to the corresponding executables. The runner creates its own loopback RPC endpoint, uses public test keys, and stops the node on exit. There is no external RPC or public deployment.

The runner verifies the three vendored official files against `sources.json`, fetches Safe 1.4.1 at `bf943f80fec5ac647159d26161446ac5d716a294`, and refuses a different or dirty Safe checkout. Foundry builds with Solidity 0.8.24, Cancun, optimizer 200; transactions execute under Anvil's Prague rules. Ethers 6.17.0 and its dependency tree are locked. No project SDK or maintainer test harness is imported.

`results/report.json` contains individual outcomes and mined receipts, including reverted receipts with zero persisted logs. `results/tools.log` records build output and tool versions. GitHub Actions uploads both for the tested commit.

## Coverage

| Cases | What is exercised |
|---|---|
| 1 | Actual type-4 transaction, `0xef0100` designator, authority nonce increment and execution through the delegate |
| 12 | Registration, transition and rotation under four ERC-1271 responses: wrong magic, revert, dirty ABI padding and short return. Another key fails; the retained 7702 key succeeds. |
| 6 | Exact empty/custom-short ERC-1271 bytes, wrong-digest refusal, nonempty self-call refusal and valid policy approval across all three operations |
| 3 | Canonical first return word with trailing data remains acceptable |
| 3 | Malformed/reverting policy does not authorize an ordinary contract, including an unrelated EOA signature |
| 3 | Real SafeProxy, Safe 1.4.1 and CompatibilityFallbackHandler: 2-of-2 signatures succeed; one signer and wrong-message signatures fail |
| 3 | Actual 2-of-2 Safe transactions delegatecall SignMessageLib. Relayed empty bytes fail before approval and after approval of another digest, then succeed after correct approval. |
| 1 | Wrong chain/domain and replay are rejected with unchanged registry state |
| 1 | Wallet approval revoked after successful simulation causes the mined transaction to revert; restoring approval permits it |
| 1 | The transition authorizer cannot rotate the controller; the current controller can |
| 1 negative control | Replacing the fixed full-word decoder with the historical bytes4 expression breaks retained-key fallback on dirty padding |

Every rejected registry transaction checks receipt status, absence of persisted logs, and the unchanged head, authorization and candidate transition record where applicable. Accepted transitions independently check the transition hash and new state root. EIP-712 digests, Space IDs and SafeMessage/SafeTx signatures are computed by the client instead of the Registry's convenience hash functions.

The negative control is a single-line decoder mutation, with contract/import renaming in an ignored generated directory. It does not reproduce an entire historical deployed build.

## Finding

`IAgentMemoryState.registerSpace` still says that empty signatures are accepted only when `msg.sender == controller`. The merged specification and actual reference also accept a relayed empty signature if the controller's ERC-1271 policy approves it. The Safe signed-message cases demonstrate that path with real wallet code. A comment-only correction is appropriate; the tested runtime follows the current specification.

## Provenance and limits

The runner and policy fixtures were written separately for this repository after reviewing the official specification, the author's decision table and account tests. The official Registry is the test target, not a new independent Registry implementation. The malformed-response fixtures are test policies; Safe itself is fetched from its pinned upstream source with its original LGPL license. The three Registry files retain their CC0 notices.

This provides external execution evidence for these selected account paths. It does not establish full ERC-8350 conformance, satisfy an external audit gate, certify a deployed wallet, or cover every Safe version, bundler, gas allowance or historical wallet state. The approval-revocation case demonstrates execution-state dependence; it is not an archive-state validator. No production deployment is tested.

| Source | Raw URL |
|---|---|
| Official revision | https://github.com/ethereum/ERCs/commit/8b11215cf267f710b49ea003384e678bcf953eae |
| Account coverage request | https://github.com/AwareLiquid/AgentMemoryState/issues/21 |
| Authorization decision table | https://github.com/AwareLiquid/AgentMemoryState/blob/f654fe023909ef93e1478e79dbcee7cbd7b05835/docs/spec-baseline/AUTHORIZATION.md |
| Discussion | https://ethereum-magicians.org/t/erc-8350-agent-memory-state-registry/29098/36 |
