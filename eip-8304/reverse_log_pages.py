"""Latest-first retrieval, chronological income accounting. Author: Ted (@haot3x).

Run: python3 -m unittest -v log_pages reverse_log_pages
CC0-1.0. Standard-library application fixture, not a proof verifier or RPC client.

Inputs model already-decoded matching logs from a fixed, independently verified
query/proof context. Neither a matching head string nor count < limit verifies a
proof. Opening wallet state, canonicality, query matching, and proof validity are
external prerequisites. No upstream endpoint is contacted.
"""
import copy
import unittest
from dataclasses import dataclass, field

from log_pages import EVENTS, HEAD, IncomeReader

PATTERN = "normalized-wallet-changes-and-receipts-v1"


@dataclass(frozen=True)
class Query:
    """Normalized query metadata; not a proposed RPC wire format.

    This fixture supports positive finite limits and inclusive block bounds.
    Latest-result selection does not imply reverse order within a response.
    """

    first: int
    last: int
    limit: int
    latest: bool = True

    def __post_init__(self):
        if any(type(v) is not int for v in (self.first, self.last, self.limit)):
            raise ValueError("integer query parameters required")
        if self.first < 0 or self.first > self.last or self.limit <= 0:
            raise ValueError("invalid query bounds or limit")
        if self.latest is not True:
            raise ValueError("this consumer requires latest-result selection")


class IncompleteWindow(ValueError):
    pass


@dataclass
class LatestIncomeWindow:
    """Buffer matching events, then replay forward only after full coverage.

    Count-capped inputs retain the conservative boundary-refill policy.
    whole_blocks=True instead models an adapter-established complete block
    interval under the RPC author's soft-cap policy. It permits boundary-block
    overflow and exact-cap coverage; it is not a self-authenticating wire flag.
    """

    first: int = 100
    last: int = 101
    head: str = HEAD
    opening_wallet: str = "A"
    pattern: str = PATTERN
    seen: dict = field(default_factory=dict)
    covered: list = field(default_factory=list)

    def __post_init__(self):
        Query(self.first, self.last, 1)
        if not self.head or not self.opening_wallet or not self.pattern:
            raise ValueError("head, opening wallet and query context are required")

    def add(self, requested, effective, events, *, head=HEAD, pattern=PATTERN,
            whole_blocks=False):
        if type(whole_blocks) is not bool:
            raise ValueError("explicit whole-block coverage mode required")
        if head != self.head or pattern != self.pattern:
            raise ValueError("head or query context changed; start a new window")
        if not (self.first <= requested.first <= effective.first
                <= effective.last <= requested.last <= self.last):
            raise ValueError("response range must stay inside request and window")
        if effective.limit > requested.limit or (
            not whole_blocks and len(events) > effective.limit
        ):
            raise ValueError("response limit exceeded")

        candidate = copy.deepcopy(self.seen)
        page_positions = set()
        for event in events:
            position = event["block"], event["log"]
            if any(type(v) is not int or v < 0 for v in position):
                raise ValueError("invalid normalized position")
            if not effective.first <= position[0] <= effective.last:
                raise ValueError("event outside response range")
            if position in page_positions:
                raise ValueError("duplicate match within one response")
            page_positions.add(position)
            if position in candidate and candidate[position] != event:
                raise ValueError("conflicting event at the same position")
            if event.get("kind") not in ("receipt", "wallet-change") or not event.get("wallet"):
                raise ValueError("invalid normalized event")
            if event["kind"] == "receipt" and (
                type(event.get("amount")) is not int or event["amount"] < 0
            ):
                raise ValueError("integer base-unit receipt required")
            candidate[position] = copy.deepcopy(event)

        # Commit atomically only after every event and response field is checked.
        self.seen = candidate
        # Complete-block coverage is supplied by the upstream adapter, never
        # inferred from overflow. Otherwise use the original conservative rule.
        if whole_blocks or len(events) < effective.limit:
            interval = (effective.first, effective.last)
            if interval not in self.covered:
                self.covered.append(interval)

    def gaps(self):
        missing, start = [], self.first
        for first, last in sorted(self.covered):
            if first > start:
                missing.append((start, first - 1))
            start = max(start, last + 1)
        if start <= self.last:
            missing.append((start, self.last))
        return missing

    def total(self):
        if self.gaps():
            raise IncompleteWindow(f"missing complete ranges: {self.gaps()}")
        reader = IncomeReader(head=self.head, wallet=self.opening_wallet)
        reader.consume(self.head, [self.seen[p] for p in sorted(self.seen)])
        return reader.total


class LatestPaginationCases(unittest.TestCase):
    def test_soft_cap_finishes_boundary_block_without_refill(self):
        window = LatestIncomeWindow()
        query = Query(100, 101, 3)
        # Three newest matches reach block 100, which must be returned in full.
        # Six matches exceed the requested three; all contribute to attribution.
        window.add(query, query, EVENTS, whole_blocks=True)
        self.assertEqual((window.total(), len(window.seen)), (25, 6))

    def test_soft_cap_exact_count_has_complete_block_coverage(self):
        window = LatestIncomeWindow()
        query = Query(100, 101, 6)
        window.add(query, query, EVENTS, whole_blocks=True)
        self.assertEqual(window.total(), 25)

    def test_soft_cap_cursor_boundary_does_not_cover_earlier_blocks(self):
        window = LatestIncomeWindow(first=99)
        # The last fully covered block while scanning latest-first is 100.
        window.add(Query(99, 101, 3), Query(100, 101, 3), EVENTS, whole_blocks=True)
        self.assertEqual(window.gaps(), [(99, 99)])
        with self.assertRaises(IncompleteWindow):
            window.total()
        window.add(Query(99, 99, 3), Query(99, 99, 3), [], whole_blocks=True)
        self.assertEqual(window.total(), 25)

    def test_soft_cap_overlap_and_retries_preserve_income(self):
        window = LatestIncomeWindow()
        window.add(Query(101, 101, 1), Query(101, 101, 1), EVENTS[5:], whole_blocks=True)
        query = Query(100, 101, 3)
        window.add(query, query, list(reversed(EVENTS)), whole_blocks=True)
        before = copy.deepcopy(window)
        window.add(query, query, EVENTS, whole_blocks=True)
        self.assertEqual(window, before)
        self.assertEqual(window.total(), 25)

    def test_latest_pages_then_boundary_refill_total_25(self):
        window = LatestIncomeWindow()
        # Three newest matches: two in block 100, one in block 101.
        window.add(Query(100, 101, 3), Query(100, 101, 3), EVENTS[3:])
        with self.assertRaises(IncompleteWindow):
            window.total()
        window.add(Query(101, 101, 2), Query(101, 101, 2), EVENTS[5:])
        window.add(Query(100, 100, 6), Query(100, 100, 6), EVENTS[:5])
        self.assertEqual(window.gaps(), [])
        self.assertEqual((window.total(), len(window.seen)), (25, 6))

    def test_retrieval_order_and_in_page_order_do_not_change_attribution(self):
        window = LatestIncomeWindow()
        window.add(Query(101, 101, 2), Query(101, 101, 2), EVENTS[5:])
        window.add(Query(100, 100, 6), Query(100, 100, 6), list(reversed(EVENTS[:5])))
        self.assertEqual(window.total(), 25)
        # The current wallet alone incorrectly counts its earlier unrelated 50.
        current_wallet_only = sum(e.get("amount", 0) for e in EVENTS if e["wallet"] == "B")
        self.assertEqual(current_wallet_only, 68)

    def test_smaller_effective_limit_is_not_a_complete_short_page(self):
        window = LatestIncomeWindow()
        window.add(Query(100, 101, 20), Query(100, 101, 2), EVENTS[-2:])
        self.assertEqual(window.gaps(), [(100, 101)])
        with self.assertRaises(IncompleteWindow):
            window.total()

    def test_narrowed_response_covers_only_its_effective_range(self):
        window = LatestIncomeWindow()
        window.add(Query(100, 101, 10), Query(101, 101, 10), EVENTS[5:])
        self.assertEqual(window.gaps(), [(100, 100)])
        with self.assertRaises(IncompleteWindow):
            window.total()
        window.add(Query(100, 100, 6), Query(100, 100, 6), EVENTS[:5])
        self.assertEqual(window.total(), 25)

    def test_empty_narrowed_page_does_not_close_an_earlier_gap(self):
        window = LatestIncomeWindow(last=102)
        window.add(Query(100, 102, 10), Query(102, 102, 10), [])
        self.assertEqual(window.gaps(), [(100, 101)])
        with self.assertRaises(IncompleteWindow):
            window.total()
        window.add(Query(100, 101, 7), Query(100, 101, 7), EVENTS)
        self.assertEqual(window.total(), 25)

    def test_exact_limit_requires_more_evidence_even_if_all_events_arrived(self):
        window = LatestIncomeWindow()
        window.add(Query(100, 101, 6), Query(100, 101, 6), EVENTS)
        with self.assertRaises(IncompleteWindow):
            window.total()
        window.add(Query(100, 101, 7), Query(100, 101, 7), EVENTS)
        self.assertEqual(window.total(), 25)

    def test_repeated_capped_page_does_not_become_complete_after_deduplication(self):
        window = LatestIncomeWindow()
        query = Query(100, 101, 3)
        window.add(query, query, EVENTS[3:])
        before = copy.deepcopy(window)
        window.add(query, query, EVENTS[3:])
        self.assertEqual(window, before)
        with self.assertRaises(IncompleteWindow):
            window.total()

    def test_skipping_boundary_block_leaves_gap_and_misses_seven(self):
        window = LatestIncomeWindow(first=99)
        window.add(Query(99, 101, 3), Query(99, 101, 3), EVENTS[3:])
        window.add(Query(101, 101, 2), Query(101, 101, 2), EVENTS[5:])
        window.add(Query(99, 99, 10), Query(99, 99, 10), [])
        self.assertEqual(window.gaps(), [(100, 100)])
        with self.assertRaises(IncompleteWindow):
            window.total()
        # A naive skip returns only 13 + 5, losing the 7 before the wallet change.
        self.assertEqual(EVENTS[4]["amount"] + EVENTS[5]["amount"], 18)
        window.add(Query(100, 100, 6), Query(100, 100, 6), EVENTS[:5])
        self.assertEqual(window.total(), 25)

    def test_overlapping_complete_pages_never_double_count(self):
        window = LatestIncomeWindow()
        window.add(Query(100, 100, 6), Query(100, 100, 6), EVENTS[:5])
        window.add(Query(100, 101, 7), Query(100, 101, 7), EVENTS)
        window.add(Query(100, 101, 7), Query(100, 101, 7), EVENTS)
        self.assertEqual((window.total(), len(window.seen)), (25, 6))

    def test_conflicting_overlap_rolls_back_new_events_and_coverage(self):
        window = LatestIncomeWindow()
        window.add(Query(101, 101, 2), Query(101, 101, 2), EVENTS[5:])
        before = copy.deepcopy(window)
        with self.assertRaisesRegex(ValueError, "conflicting"):
            window.add(Query(100, 101, 7), Query(100, 101, 7),
                       EVENTS[:5] + [{**EVENTS[5], "amount": 500}])
        self.assertEqual(window, before)

    def test_duplicate_within_page_is_not_a_valid_match_count(self):
        window = LatestIncomeWindow()
        with self.assertRaisesRegex(ValueError, "duplicate"):
            window.add(Query(100, 101, 3), Query(100, 101, 3), [EVENTS[5], EVENTS[5]])
        self.assertEqual((window.seen, window.covered), ({}, []))

    def test_head_change_requires_new_context_without_partial_commit(self):
        window = LatestIncomeWindow()
        window.add(Query(101, 101, 2), Query(101, 101, 2), EVENTS[5:])
        before = copy.deepcopy(window)
        with self.assertRaisesRegex(ValueError, "head or query"):
            window.add(Query(100, 100, 6), Query(100, 100, 6), EVENTS[:5], head="reorg-B")
        self.assertEqual(window, before)

    def test_changed_filter_cannot_complete_a_window(self):
        window = LatestIncomeWindow()
        with self.assertRaisesRegex(ValueError, "head or query"):
            window.add(Query(100, 101, 7), Query(100, 101, 7), EVENTS, pattern="receipts-only")
        self.assertEqual((window.seen, window.covered), ({}, []))

    def test_response_outside_requested_range_is_rejected(self):
        window = LatestIncomeWindow()
        with self.assertRaisesRegex(ValueError, "range"):
            window.add(Query(101, 101, 7), Query(100, 101, 7), EVENTS)
        self.assertEqual(window.seen, {})

    def test_event_outside_effective_range_rolls_back_page(self):
        window = LatestIncomeWindow()
        with self.assertRaisesRegex(ValueError, "event outside"):
            window.add(Query(100, 101, 7), Query(101, 101, 7), [EVENTS[5], EVENTS[0]])
        self.assertEqual((window.seen, window.covered), ({}, []))

    def test_match_count_above_effective_limit_is_rejected(self):
        window = LatestIncomeWindow()
        with self.assertRaisesRegex(ValueError, "limit exceeded"):
            window.add(Query(100, 101, 7), Query(100, 101, 2), EVENTS[3:])
        self.assertEqual(window.seen, {})

    def test_opening_wallet_state_cannot_be_unknown(self):
        with self.assertRaisesRegex(ValueError, "opening wallet"):
            LatestIncomeWindow(opening_wallet="")

    def test_large_integer_receipts_remain_exact(self):
        events = copy.deepcopy(EVENTS)
        events[0]["amount"] = 2**128 + 7
        window = LatestIncomeWindow()
        window.add(Query(100, 101, 7), Query(100, 101, 7), events)
        self.assertEqual(window.total(), 2**128 + 25)

    def test_empty_complete_window_returns_zero(self):
        window = LatestIncomeWindow(first=102, last=103, opening_wallet="B")
        query = Query(102, 103, 10)
        window.add(query, query, [])
        self.assertEqual(window.total(), 0)

    def test_false_completeness_claim_still_requires_external_proof_verification(self):
        window = LatestIncomeWindow()
        omitted = [e for e in EVENTS if e != EVENTS[4]]
        window.add(Query(100, 101, 7), Query(100, 101, 7), omitted)
        # Deliberately violates the verified-input prerequisite. Bookkeeping
        # cannot detect this omission: proof verification is an external gate.
        self.assertEqual(window.total(), 12)


if __name__ == "__main__":
    unittest.main(verbosity=2)
