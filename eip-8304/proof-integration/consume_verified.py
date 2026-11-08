"""Local test bridge from the Go verifier to the existing income consumer.

CC0-1.0. Author: Ted (@haot3x).
Only the parent Go test supplies this input; accepting arbitrary JSON here is
not proof verification. No RPC endpoint or external service is involved.
"""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from reverse_log_pages import IncompleteWindow, LatestIncomeWindow, Query

bundle = json.load(sys.stdin)
window = LatestIncomeWindow(first=1, last=2, head=bundle["head"])
for page in bundle["pages"]:
    window.add(Query(**page["requested"]), Query(**page["effective"]),
               page["events"], head=bundle["head"])
    if page["complete"]:
        assert window.total() == 25, window.total()
    else:
        try:
            window.total()
        except IncompleteWindow:
            pass
        else:
            raise AssertionError("partial input incorrectly closed the window")
assert window.total() == 25, window.total()
assert len(window.seen) == 6, len(window.seen)
print(json.dumps({"income": window.total(), "unique_events": len(window.seen)}))
