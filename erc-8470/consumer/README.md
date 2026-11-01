# Local liquidity reader

Author: Ted (@haot3x). CC0-1.0.

`LiquidityObservationReader.sol` reads the latest observation for one token from a fixed registry and detector, then checks a configured `lpLockedShare` minimum. It is a small consumer example, not a full trading guard or token-safety recommendation.

The new rules come from [Zealynx's minimum-value review](https://ethereum-magicians.org/t/erc-8470-launch-observations/30112/14) and [Revinand's freshness review](https://ethereum-magicians.org/t/erc-8470-launch-observations/30112/16), incorporated into the upstream specification through `0d6a107`. Those findings are theirs; this contribution supplies executable consumer regressions.

## Policy

- Fix the trusted registry, detector, minimum locked basis points and maximum block age at construction.
- Use the latest observation for that detector/token; do not fall back to an earlier favorable reading when the newest one is unavailable.
- Require matching chain/token/detector context and the stored `hashChecked` flag.
- Check `observedBlock` against the current block on the same chain, using ArbSys on Arbitrum. `recordedAt` is not used for freshness.
- Reject a missing `lpLockedShare`, `type(uint256).max`, or a measurement below the configured minimum.
- Reject every cross-chain request. This example has no authenticated source-header or oracle integration and does not invent one from publication time.

The default test policy is an inclusive maximum age of 100 blocks and a minimum locked share of 8,000 basis points. These are synthetic test choices, not recommended trading parameters. The reader does not verify venue declarations, ERC-8004 identity, finding truth, finality, later reorganizations, or other trading conditions. A caller must handle a revert as a failed check. A successful read only means this one policy passed under the configured trust assumptions.

## Tests

From `erc-8470`, run:

```sh
forge test --match-contract ConsumerPolicyTest -vv
```

Twelve local tests use the real pinned registry with mocked chain history. They cover the exact age/value boundaries, explicit not-read and omitted findings, missing observations, an untrusted detector, late publication, a same-block correction, unavailable data replacing a previous good observation, unsupported cross-chain data, L2 block numbers, and an unchecked own-chain hash.

The not-read case includes a negative control showing that `max >= 8000` passes. Two targeted source mutations were also checked: removing the not-read rejection makes that test fail; replacing observed-block age with publication age makes the same-block correction test fail. Both mutations were restored before the full test run.
