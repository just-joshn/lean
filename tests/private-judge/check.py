import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
TARGET = HERE / ("evidence/controller-before.py" if "--baseline" in sys.argv else "controller.py")
spec = importlib.util.spec_from_file_location("private_judge", TARGET)
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)
saved = json.loads((HERE / "saved-cases.json").read_bytes())
original_hashes = json.loads(
    (HERE / "evidence/original-hashes.json").read_bytes()
)
EXPECTED_ACTUAL = {"node-normal", "node-start-throw", "bun-normal", "bun-start-throw"}
EXPECTED_COUNTEREXAMPLES = {
    ("node", "collector-exit-and-close-code-7"),
    ("node", "missing-collector-exit"),
    ("bun", "collector-exit-and-close-code-7"),
    ("bun", "missing-collector-exit"),
}
actual_names = [case["name"] for case in saved["actual"]]
assert len(actual_names) == 4 and len(set(actual_names)) == 4
assert set(actual_names) == EXPECTED_ACTUAL
counterexample_inventory = [
    (case["runtime"], case["mutation"]) for case in saved["counterexamples"]
]
assert len(counterexample_inventory) == 4
assert len(set(counterexample_inventory)) == 4
assert set(counterexample_inventory) == EXPECTED_COUNTEREXAMPLES
failures = []
actual_accepted = 0
false_accepted = 0
negative_accepted = 0
negative_count = 0
positive_accepted = 0
results = []


def encode(rows):
    rows = copy.deepcopy(rows)
    for seq, row in enumerate(rows, 1):
        row["seq"] = seq
    return b"".join(json.dumps(row).encode() + b"\n" for row in rows)


def judge(case, rows=None, outcome=None):
    launch = copy.deepcopy(case["launch"])
    launch["recordedPid"] = case["pid"]["pid"]
    raw = case["stdout"].encode() if rows is None else encode(rows)
    fn = controller.judge_throw if case["name"].endswith("start-throw") else controller.judge_normal
    return fn(
        raw,
        case["stderr"].encode(),
        case["outcome"] if outcome is None else outcome,
        launch,
    )


def check_negative(case, label, rows, reason, outcome=None, recorded=False):
    global false_accepted, negative_accepted, negative_count
    negative_count += 1
    try:
        result = judge(case, rows, outcome)
        accepted = result["classification"] == "observed"
        negative_accepted += accepted
        if recorded:
            false_accepted += accepted
        if accepted or not any(reason in issue for issue in result["issues"]):
            failures.append(f"{case['name']}/{label}: {result['classification']} {result['issues']}")
        results.append({"case": case["name"], "control": label, "synthetic": True, "recordedCounterexample": recorded, "classification": result["classification"], "issues": result["issues"]})
    except Exception as error:
        failures.append(f"{case['name']}/{label}: judge raised {type(error).__name__}: {error}")


for case in saved["actual"]:
    for stream in ["stdout", "stderr"]:
        expected = original_hashes[f"{case['provenance']}/{stream}.bin"]
        assert hashlib.sha256(case[stream].encode()).hexdigest() == expected
    actual = judge(case)
    actual_accepted += actual["classification"] == "observed"
    if actual["classification"] != "observed" or actual["issues"]:
        failures.append(f"{case['name']}: actual control rejected {actual['issues']}")
    if not case["name"].endswith("start-throw"):
        continue
    rows = [json.loads(line) for line in case["stdout"].splitlines()]
    for original in [row for row in saved["counterexamples"] if case["name"].startswith(row["runtime"])]:
        mutated = copy.deepcopy(rows)
        if original["mutation"] == "collector-exit-and-close-code-7":
            for row in mutated:
                if row["kind"] in ["hook-exit", "hook-close"]:
                    row["code"] = row["exitCode"] = 7
            reason = "natural"
        elif original["mutation"] == "missing-collector-exit":
            mutated = [row for row in mutated if row["kind"] != "hook-exit"]
            reason = "exit"
        else:
            raise AssertionError(f"unknown mutation {original['mutation']}")
        check_negative(case, original["mutation"], mutated, reason, recorded=True)
    for kind in ["hook-exit", "hook-close"]:
        for label, replacement in [("missing", None), ("duplicate", "duplicate")]:
            mutated = copy.deepcopy(rows)
            packet = next(row for row in mutated if row["kind"] == kind)
            if replacement is None:
                mutated.remove(packet)
            else:
                mutated.append(copy.deepcopy(packet))
            check_negative(case, f"{kind}-{label}", mutated, "exit or close")
        for field, values in [("pid", [None, False, str(next(row["pid"] for row in rows if row["kind"] == kind)), float(next(row["pid"] for row in rows if row["kind"] == kind))]), ("command", [None, "other"]), ("code", [None, False, True, "0", 0.0, 7]), ("exitCode", [None, False, True, "0", 0.0, 7]), ("signal", ["SIGTERM", False, 0, ""]), ("signalCode", ["SIGTERM", False, 0, ""])]:
            for label, value in [("absent", None)] + [(repr(value), value) for value in values]:
                mutated = copy.deepcopy(rows)
                packet = next(row for row in mutated if row["kind"] == kind)
                if label == "absent":
                    del packet[field]
                else:
                    packet[field] = value
                missing_terminal = label == "absent" and field in ["code", "signal", "pid"] or field == "pid" and (value is None or type(value) is not float)
                check_negative(case, f"{kind}-{field}-{label}", mutated, "exit or close" if missing_terminal else "natural")
        mutated = copy.deepcopy(rows)
        packet = next(row for row in mutated if row["kind"] == kind)
        packet["code"] = packet["exitCode"] = None
        packet["signal"] = packet["signalCode"] = "SIGTERM"
        check_negative(case, f"{kind}-signal-termination", mutated, "natural")
        mutated = copy.deepcopy(rows)
        malformed = copy.deepcopy(next(row for row in mutated if row["kind"] == kind))
        del malformed["code"]
        mutated.append(malformed)
        check_negative(case, f"{kind}-malformed-duplicate", mutated, "exit or close")
    for label, first, second, reason in [("close-before-exit", "hook-close", "hook-exit", "order"), ("exit-before-create", "hook-exit", "hook-create", "order"), ("join-before-close", "hook-joined", "hook-close", "closure"), ("join-before-reject", "hook-joined", "api-reject", "rejection"), ("callback-before-create", "start-callback", "hook-create", "order"), ("rejection-before-callback", "api-reject", "start-callback", "order")]:
        mutated = copy.deepcopy(rows)
        packet = next(row for row in mutated if row["kind"] == first)
        mutated.remove(packet)
        mutated.insert(next(i for i, row in enumerate(mutated) if row["kind"] == second), packet)
        check_negative(case, label, mutated, reason)
    for kind, field, values, reason in [("start-callback", "spawnCalls", [None, False, "0", 0.0, 1], "callback"), ("api-reject", "sameObject", [None, False, 1], "owned error"), ("api-reject", "tokenMatches", [None, False, 1], "owned error"), ("hook-joined", "count", [None, False, True, "1", 1.0, 0, 2], "join"), ("hook-joined", "rows", [None, {}, [], [None]], "join")]:
        for label, value in [("absent", None)] + [(repr(value), value) for value in values]:
            mutated = copy.deepcopy(rows)
            packet = next(row for row in mutated if row["kind"] == kind)
            if label == "absent":
                del packet[field]
            else:
                packet[field] = value
            check_negative(case, f"{kind}-{field}-{label}", mutated, reason)
    for field, values in [("pid", [None, True, "34914", 1]), ("code", [None, False, "0", 7]), ("signal", [False, "SIGTERM"]), ("command", [None, "other"])]:
        for label, value in [("absent", None)] + [(repr(value), value) for value in values]:
            mutated = copy.deepcopy(rows)
            packet = next(row for row in mutated if row["kind"] == "hook-joined")["rows"][0]
            if label == "absent":
                del packet[field]
            else:
                packet[field] = value
            check_negative(case, f"join-row-{field}-{label}", mutated, "join")
    for field, values in [("returncode", [None, False, "0", 0.0, 7]), ("timedOut", [None, 0, "", True]), ("signalSent", [None, 0, "", True])]:
        for label, value in [("absent", None)] + [(repr(value), value) for value in values]:
            outcome = copy.deepcopy(case["outcome"])
            if label == "absent":
                del outcome[field]
            else:
                outcome[field] = value
            check_negative(case, f"outcome-{field}-{label}", rows, "runner", outcome)
    reordered = copy.deepcopy(rows)
    rejected = next(row for row in reordered if row["kind"] == "api-reject")
    reordered.remove(rejected)
    reordered.insert(next(i for i, row in enumerate(reordered) if row["kind"] == "hook-joined"), rejected)
    positive = judge(case, reordered)
    positive_accepted += positive["classification"] == "observed"
    if positive["classification"] != "observed" or positive["issues"]:
        failures.append(f"{case['name']}/close-before-rejection: {positive['issues']}")

if actual_accepted != 4:
    failures.append(f"actual saved cases accepted: {actual_accepted}/4")
if false_accepted != 0:
    failures.append(f"recorded false acceptances: {false_accepted}/4")
if negative_count != 278:
    failures.append(f"synthetic negative control count: {negative_count}/278")
if negative_accepted != 0:
    failures.append(f"synthetic negative acceptances: {negative_accepted}/278")
if positive_accepted != 2:
    failures.append(f"close-before-rejection controls accepted: {positive_accepted}/2")
print(f"actual saved cases accepted: {actual_accepted}/4")
print(f"recorded false acceptances: {false_accepted}/4")
print(f"synthetic negative acceptances: {negative_accepted}/{negative_count}")
print(f"close-before-rejection controls accepted: {positive_accepted}/2")
print(f"contract failures: {len(failures)}")
print(json.dumps({"target": TARGET.name, "failures": failures, "negativeControls": results}))
raise SystemExit(bool(failures))
