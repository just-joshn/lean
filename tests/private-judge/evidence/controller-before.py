import json
import os

EXPECTED_STDOUT = "native-command-observer-bytes\n"
OWNED_KEYS = ("PATH", "HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME")


def parse_packets(raw: bytes) -> tuple[list, list]:
    packets = []
    issues = []
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return packets, ["stdout is not utf-8"]
    for line_no, line in enumerate(text.splitlines(), 1):
        if line == "":
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            issues.append(f"stdout line {line_no} is not json")
            continue
        if not isinstance(row, dict) or type(row.get("seq")) is not int or type(row.get("kind")) is not str:
            issues.append(f"stdout line {line_no} is not a packet")
            continue
        packets.append(row)
    seqs = [row["seq"] for row in packets]
    if seqs != list(range(1, len(seqs) + 1)):
        issues.append("packet sequence is not contiguous")
    return packets, issues


def rows_of(packets: list, kind: str) -> list:
    return [row for row in packets if row.get("kind") == kind]


def positive_pid(value) -> bool:
    return type(value) is int and value > 1


def order_of(packets: list) -> list:
    return [
        {
            "seq": row["seq"],
            "kind": row["kind"],
            "command": row.get("command"),
            "pid": row.get("pid"),
        }
        for row in packets
    ]


def env_issues(launch_env: dict, packets: list) -> tuple[list, list]:
    issues = []
    deviations = []
    started = rows_of(packets, "runner-start")
    if len(started) != 1:
        issues.append("runner-start packet missing")
        return issues, deviations
    observed = started[0].get("env")
    if not isinstance(observed, dict):
        issues.append("runner env missing")
        return issues, deviations
    for key in OWNED_KEYS:
        if observed.get(key) != launch_env.get(key):
            issues.append(f"owned env mismatch for {key}")
    extra = sorted(set(observed) - set(OWNED_KEYS))
    if extra:
        deviations.append({"extraEnvKeys": extra})
    return issues, deviations


def stream_identity(row: dict) -> bool:
    streams = row.get("streams")
    return isinstance(streams, dict) and all(name in streams for name in ("stdin", "stdout", "stderr"))


def close_row(packets: list, pid: int, kind: str) -> dict | None:
    found = [
        row
        for row in rows_of(packets, kind)
        if row.get("pid") == pid and "code" in row and "signal" in row
    ]
    if len(found) != 1:
        return None
    return found[0]


def judge_normal(raw_stdout: bytes, raw_stderr: bytes, outcome: dict, launch: dict) -> dict:
    issues = []
    deviations = []
    packets, parse_issues = parse_packets(raw_stdout)
    issues.extend(parse_issues)
    if raw_stderr:
        issues.append("runner stderr was not empty")
        deviations.append({"stderrBytes": len(raw_stderr)})
    order = order_of(packets)
    if outcome["waitOutcome"] != "reaped-runner" or outcome["timedOut"] or outcome["signalSent"]:
        issues.append("runner wait did not reap cleanly")
        return {
            "classification": "inconclusive",
            "issues": issues,
            "controlPassed": False,
            "childCompleted": False,
            "synthetic": False,
            "order": order,
            "deviations": deviations,
            "packets": packets,
        }
    env_problem, env_deviation = env_issues(launch["env"], packets)
    issues.extend(env_problem)
    deviations.extend(env_deviation)
    started = rows_of(packets, "runner-start")
    exec_path = started[0].get("execPath") if started else None
    if not isinstance(exec_path, str) or not os.path.samefile(exec_path, launch["argv"][0]):
        issues.append("action runtime is not the launched runtime")
    if rows_of(packets, "hook-install-returned") == [] or rows_of(packets, "source-imported") == []:
        issues.append("hook install or source import missing")
    else:
        install_seq = rows_of(packets, "hook-install-returned")[0]["seq"]
        import_seq = rows_of(packets, "source-imported")[0]["seq"]
        if not install_seq < import_seq:
            issues.append("source import was not after hook install")
    creates = rows_of(packets, "hook-create")
    cats = [row for row in creates if row.get("command") == "/bin/cat" and row.get("handleRetained") is True]
    actions = [row for row in creates if row.get("command") == exec_path and row.get("handleRetained") is True]
    if len(creates) != 2 or len(cats) != 1 or len(actions) != 1:
        issues.append("normal capture did not retain cat and the action")
    callback = rows_of(packets, "start-callback")
    if len(callback) != 1 or callback[0].get("threw") is not False:
        issues.append("normal callback did not record a spawn path")
    cat_pid = cats[0].get("pid") if len(cats) == 1 else None
    action_pid = actions[0].get("pid") if len(actions) == 1 else None
    if not positive_pid(cat_pid) or not positive_pid(action_pid) or cat_pid == action_pid:
        issues.append("collector and action pids were not distinct positive pids")
    cat_exit = close_row(packets, cat_pid, "hook-exit") if positive_pid(cat_pid) else None
    cat_close = close_row(packets, cat_pid, "hook-close") if positive_pid(cat_pid) else None
    action_exit = close_row(packets, action_pid, "hook-exit") if positive_pid(action_pid) else None
    action_close = close_row(packets, action_pid, "hook-close") if positive_pid(action_pid) else None
    if cat_exit is None or cat_close is None or action_exit is None or action_close is None:
        issues.append("missing exit or close record")
    returned = rows_of(packets, "api-return")
    joined = rows_of(packets, "hook-joined")
    if len(returned) != 1:
        issues.append("api return missing")
    else:
        api = returned[0]
        if api.get("stdout") != EXPECTED_STDOUT or api.get("returncode") != 0:
            issues.append("api stdout or returncode mismatch")
        if cat_close is None or not cat_close["seq"] < api["seq"]:
            issues.append("collector close did not precede api return")
        if action_exit is None or not action_exit["seq"] < api["seq"]:
            issues.append("action exit did not precede api return")
        if len(joined) != 1 or not api["seq"] < joined[0]["seq"]:
            issues.append("join was not recorded after api return")
        if action_close is not None and action_close["seq"] < api["seq"]:
            deviations.append({"actionCloseBeforeApiReturn": True, "actionCloseSeq": action_close["seq"], "apiSeq": api["seq"]})
        elif action_close is not None:
            deviations.append({"actionCloseBeforeApiReturn": False, "actionCloseSeq": action_close["seq"], "apiSeq": api["seq"]})
    if action_exit is not None and (action_exit.get("code") != 0 or action_exit.get("signal") is not None):
        issues.append("action did not exit naturally")
    if cat_close is not None and (cat_close.get("code") != 0 or cat_close.get("signal") is not None):
        issues.append("collector close was not natural")
    if action_close is not None and (action_close.get("code") != 0 or action_close.get("signal") is not None):
        issues.append("action close was not natural")
    if rows_of(packets, "timeout-callback") or rows_of(packets, "hook-error") or rows_of(packets, "runner-error") or rows_of(packets, "hook-sync"):
        issues.append("timeout, hook error, runner error, or spawnSync appeared")
    if started and started[0].get("pid") != launch.get("recordedPid"):
        issues.append("runner-start pid disagrees with recorded runner pid")
    if len(cats) == 1 and not stream_identity(cats[0]):
        issues.append("collector stream identity missing")
    if len(actions) == 1 and not stream_identity(actions[0]):
        issues.append("action stream identity missing")
    classification = "observed" if not issues else "failed"
    if classification == "observed" and outcome["returncode"] != 0:
        issues.append("runner exit disagrees with observed contract")
        classification = "failed"
    return {
        "classification": classification,
        "issues": issues,
        "controlPassed": False,
        "childCompleted": False,
        "synthetic": False,
        "order": order,
        "deviations": deviations,
        "packets": packets,
    }


def judge_throw(raw_stdout: bytes, raw_stderr: bytes, outcome: dict, launch: dict) -> dict:
    issues = []
    deviations = []
    packets, parse_issues = parse_packets(raw_stdout)
    issues.extend(parse_issues)
    if raw_stderr:
        issues.append("runner stderr was not empty")
        deviations.append({"stderrBytes": len(raw_stderr)})
    order = order_of(packets)
    if outcome["waitOutcome"] != "reaped-runner" or outcome["timedOut"] or outcome["signalSent"]:
        issues.append("runner wait did not reap cleanly")
        return {
            "classification": "inconclusive",
            "issues": issues,
            "controlPassed": False,
            "childCompleted": False,
            "synthetic": False,
            "order": order,
            "deviations": deviations,
            "packets": packets,
        }
    env_problem, env_deviation = env_issues(launch["env"], packets)
    issues.extend(env_problem)
    deviations.extend(env_deviation)
    creates = rows_of(packets, "hook-create")
    callback = rows_of(packets, "start-callback")
    rejected = rows_of(packets, "api-reject")
    joined = rows_of(packets, "hook-joined")
    callback_justifies = (
        len(callback) == 1
        and callback[0].get("phase") == "before-spawn"
        and callback[0].get("threw") is True
        and callback[0].get("spawnCalls") == 0
    )
    if not callback_justifies:
        issues.append("zero actions is not justified by the callback path")
    cats = [row for row in creates if row.get("command") == "/bin/cat" and row.get("handleRetained") is True]
    if len(creates) != 1 or len(cats) != 1:
        issues.append("throw capture did not retain only the collector")
    cat_pid = cats[0].get("pid") if len(cats) == 1 else None
    if not positive_pid(cat_pid):
        issues.append("collector pid missing")
    cat_close = close_row(packets, cat_pid, "hook-close") if positive_pid(cat_pid) else None
    if cat_close is None:
        issues.append("collector close missing")
    if len(rejected) != 1 or rejected[0].get("sameObject") is not True:
        issues.append("rejection was not the owned error object")
    if rows_of(packets, "api-return"):
        issues.append("throw branch returned an api result")
    if len(rejected) == 1 and len(joined) == 1:
        if not rejected[0]["seq"] < joined[0]["seq"]:
            issues.append("join was not recorded after rejection")
        if cat_close is not None:
            relation = "close-before-reject" if cat_close["seq"] < rejected[0]["seq"] else "reject-before-close"
            deviations.append({"collectorCloseVersusReject": relation, "closeSeq": cat_close["seq"], "rejectSeq": rejected[0]["seq"]})
    else:
        issues.append("reject or join record missing")
    if rows_of(packets, "timeout-callback") or rows_of(packets, "hook-error") or rows_of(packets, "runner-error") or rows_of(packets, "hook-sync"):
        issues.append("timeout, hook error, runner error, or spawnSync appeared")
    started = rows_of(packets, "runner-start")
    if started and started[0].get("pid") != launch.get("recordedPid"):
        issues.append("runner-start pid disagrees with recorded runner pid")
    classification = "observed" if not issues else "failed"
    if classification == "observed" and outcome["returncode"] != 0:
        issues.append("runner exit disagrees with observed contract")
        classification = "failed"
    return {
        "classification": classification,
        "issues": issues,
        "controlPassed": False,
        "childCompleted": False,
        "synthetic": False,
        "order": order,
        "deviations": deviations,
        "packets": packets,
    }
