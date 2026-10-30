# EIP-8304 application log consumer

Author: Ted (@haot3x)


Run `python3 -m unittest -v log_pages reverse_log_pages` (Python standard library only). **32 tests pass: eight original forward-consumer cases and twenty-four latest-first cases, including four whole-block soft-cap cases.** Download both Python files into the same directory. `python3 log_pages.py` still runs the original eight tests by itself.

An agent starts with wallet A. In one block it receives 7 at A, then an unrelated 50 at B, changes its wallet to B, then receives an unrelated 11 at A and a valid 13 at B. The next block adds 5 at B. Correct income is **25**, including when a page ends immediately after the wallet change. Using the final wallet B for every historical receipt incorrectly gives 68.

### Whole-block soft-cap update (29 October 2026)

The RPC author clarified the intended policy in [post 10](https://ethereum-magicians.org/t/eip-8304-trustless-log-and-transaction-index/28824/10): finish the boundary block even if the match count exceeds the limit, and make the cursor identify the last fully covered block. The PR text had not yet incorporated that clarification when this fixture was updated.

The consumer now accepts `whole_blocks=True` for an adapter-established complete effective block interval. This is a local input mode, not a proposed RPC field or a substitute for upstream completeness verification. It allows overflow and exact-cap pages to cover that interval. The default conservative mode and its boundary-refill cases remain for count-truncated inputs.

Four added cases cover:

- A latest-results limit of 3 returns all 6 matches after finishing block 100; income remains 25 without a refill.
- An exactly-at-limit page covers its adapter-established complete block interval.
- Completing blocks 100–101 does not falsely cover block 99 from the wider request.
- Overlapping/retried whole-block pages retain chronological attribution without double counting.

`python3 -B -m unittest -v log_pages reverse_log_pages` passes all **32 tests**. The normalized effective range must be derived from the real response/cursor semantics by a future adapter. This update does not implement the RPC endpoint, a wire-format adapter, or a proof verifier. No live endpoint was queried.

### Earlier count-truncated retrieval cases (27 October 2026)

`reverse_log_pages.py` buffers normalized matching events retrieved from newer ranges first and replays them chronologically only after the requested window is covered. Latest-result selection does not require reverse order inside each response: the reviewed upstream prover sorts its block results ascending, and the fixture handles either supplied order.

| Consumer case | Tested result |
|---|---|
| Latest three matches, then skip their partially returned boundary block | The remaining complete-range gap blocks a final total; the naive skipped subset has 18 instead of 25 |
| Requery that block with a high enough accepted limit | All six unique events remain; correct total is 25 |
| Retry or overlap pages | No duplicate income; repeating a capped page does not make it complete |
| Requested limit 20, effective limit 2, two returned matches | Capped, not complete; use the response limit |
| Prover returns a narrower range, including an empty later range | Only that effective range contributes coverage; earlier gaps remain |
| Returned count equals the effective limit | Conservatively incomplete, even if it happens to equal the real total |
| Reference head, filter context or duplicate event contents change | Reject the response without a partial update |
| Large integer token amounts | Exact integer accounting, including amounts above 2^128 |

The default count-truncated mode supports positive finite limits. It uses a conservative policy: only a response with fewer matches than its effective limit closes its entire effective block range. Capped responses retain events but close no whole-block interval here. A proof-aware adapter could extract finer proven ranges; this fixture does not do so. If the prover's hard cap prevents completing a boundary block, the reader remains incomplete. It does not silently skip that block, invent a cursor, or automatically retry forever. Refilling with a higher limit is a tested local strategy, not a guaranteed endpoint capability.

The input is a normalized union of identity-registry changes and token receipts using block-global RPC log positions. The opening wallet state at the beginning of the window must be independently established. Real proof decoding, query matching, accepted index contracts and reference-head validation belong upstream of this fixture. `Query`, `head` and `pattern` are local test abstractions, not proposed or standardized RPC fields. No proof parser, verifier, RPC client or server is implemented here, and no request was sent to the author's home-hosted endpoint.

A short match count establishes coverage **only under the independently verified-input prerequisite**. The negative control deliberately violates it: removing the valid 13-unit receipt while claiming the full range produces 12. Bookkeeping cannot detect that lie; real inclusion/exclusion proof verification is still required. Converting transaction/frame-relative proof positions into RPC log positions is also outside the fixture.

Three targeted mutations were caught: substituting the requested limit for the effective limit, marking the requested range instead of the effective range as covered, and replaying arrival order instead of chronological order. Each corresponding regression failed; restored code passed all 28 tests. This is application evidence, not a demonstrated defect in the upstream endpoint or verifier.

Sources reviewed:

- Author's latest-first recommendation: https://ethereum-magicians.org/t/eip-8304-trustless-log-and-transaction-index/28824/8
- Query document, pinned: https://github.com/zsfelfoldi/tli/blob/693ad8b4672bef55836b40d0e53bd09d5fc0b037/log_index_query.md
- Proof representation, pinned: https://github.com/zsfelfoldi/tli/blob/693ad8b4672bef55836b40d0e53bd09d5fc0b037/log_index_proof.md
- Prover source inspected (not executed): https://github.com/zsfelfoldi/go-ethereum/blob/38c64aed6c8c2409f8926c6b07a5b304b14b4988/core/logindex/logquery/prover.go
- Verifier source inspected (not executed): https://github.com/zsfelfoldi/go-ethereum/blob/38c64aed6c8c2409f8926c6b07a5b304b14b4988/core/logindex/logquery/query_proof.go
- JSON-RPC discussion: https://github.com/ethereum/execution-apis/pull/900

## License

CC0-1.0. This application fixture does not copy upstream client implementation code.
