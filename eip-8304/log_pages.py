"""Agent-income pagination fixture; not an EIP-8304 proof verifier or RPC server.

Run: python3 log_pages.py
Author: Ted (@haot3x)
"""
import copy
import unittest
from dataclasses import dataclass, field

HEAD = "canonical-head-A"
# Positions use RPC-style block-global logIndex, not EIP-8304's internal
# transaction-relative (and potentially frame-relative) encoding.
EVENTS = [
    {"block": 100, "log": 0, "kind": "receipt", "wallet": "A", "amount": 7},
    {"block": 100, "log": 1, "kind": "receipt", "wallet": "B", "amount": 50},
    {"block": 100, "log": 2, "kind": "wallet-change", "wallet": "B"},
    {"block": 100, "log": 3, "kind": "receipt", "wallet": "A", "amount": 11},
    {"block": 100, "log": 4, "kind": "receipt", "wallet": "B", "amount": 13},
    {"block": 101, "log": 0, "kind": "receipt", "wallet": "B", "amount": 5},
]


@dataclass
class IncomeReader:
    """Consume an ordered, normalized event union under one expected head.

    The fixture assumes upstream provides all registry changes and matching
    token logs. Head equality is a client check, not a cryptographic proof of
    canonicality or completeness. Amounts are integer token base units.
    """

    head: str = HEAD
    wallet: str = "A"
    total: int = 0
    last: tuple = (-1, -1)
    seen: dict = field(default_factory=dict)

    def consume(self, head, events):
        if head != self.head:
            raise ValueError("head changed; discard old pagination context")
        candidate = copy.deepcopy(self)
        for event in events:
            position = event["block"], event["log"]
            if position in candidate.seen:
                if candidate.seen[position] != event:
                    raise ValueError("conflicting event at the same position")
                continue
            if position <= candidate.last:
                raise ValueError("out-of-order event")
            if event["kind"] == "wallet-change":
                candidate.wallet = event["wallet"]
            elif event["wallet"] == candidate.wallet:
                candidate.total += event["amount"]
            candidate.last = position
            candidate.seen[position] = copy.deepcopy(event)
        self.__dict__.update(candidate.__dict__)


class PaginationCases(unittest.TestCase):
    def test_whole_block_matches_expected_income(self):
        reader = IncomeReader()
        reader.consume(HEAD, EVENTS)
        self.assertEqual(reader.total, 25)  # 7 + 13 + 5, not 50 or 11

    def test_page_break_immediately_after_wallet_change(self):
        reader = IncomeReader()
        reader.consume(HEAD, EVENTS[:3])
        self.assertEqual((reader.wallet, reader.total), ("B", 7))
        reader.consume(HEAD, EVENTS[3:5])
        reader.consume(HEAD, EVENTS[5:])
        self.assertEqual(reader.total, 25)

    def test_retried_overlapping_page_does_not_double_count(self):
        reader = IncomeReader()
        reader.consume(HEAD, EVENTS[:5])
        reader.consume(HEAD, EVENTS[2:])
        self.assertEqual(reader.total, 25)

    def test_reorg_requires_new_pagination_context(self):
        reader = IncomeReader()
        reader.consume(HEAD, EVENTS[:3])
        with self.assertRaisesRegex(ValueError, "head changed"):
            reader.consume("replacement-head-B", EVENTS[3:])
        self.assertEqual((reader.wallet, reader.total), ("B", 7))

    def test_conflicting_duplicate_is_rejected(self):
        reader = IncomeReader()
        reader.consume(HEAD, EVENTS[:1])
        with self.assertRaisesRegex(ValueError, "conflicting"):
            reader.consume(HEAD, [{**EVENTS[0], "amount": 700}])
        self.assertEqual(reader.total, 7)

    def test_failed_page_does_not_partially_commit(self):
        reader = IncomeReader()
        reader.consume(HEAD, EVENTS[:1])
        with self.assertRaisesRegex(ValueError, "out-of-order"):
            reader.consume(HEAD, [EVENTS[2], EVENTS[1]])
        self.assertEqual((reader.wallet, reader.total), ("A", 7))
        reader.consume(HEAD, EVENTS[1:])
        self.assertEqual(reader.total, 25)

    def test_empty_page_preserves_wallet_state(self):
        reader = IncomeReader()
        reader.consume(HEAD, EVENTS[:3])
        reader.consume(HEAD, [])
        reader.consume(HEAD, EVENTS[3:])
        self.assertEqual(reader.total, 25)

    def test_anchor_and_deduplication_do_not_prove_completeness(self):
        reader = IncomeReader()
        reader.consume(HEAD, [e for e in EVENTS if e != EVENTS[4]])
        # A server can omit the 13-unit receipt without contradicting the
        # remaining events. A completeness proof is an additional requirement.
        self.assertEqual(reader.total, 12)


if __name__ == "__main__":
    unittest.main(verbosity=2)
