"""Offline JSONL Codex app-server fixture. No models, shell, writes, or network.

--log records received protocol messages using test data only.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import threading
import time

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
parser = argparse.ArgumentParser()
parser.add_argument("--log", type=Path)
parser.add_argument("--account-mode", default="chatgpt")
parser.add_argument("--stall-interrupt", action="store_true")
parser.add_argument("--stall-initialize", action="store_true")
args, _ = parser.parse_known_args()
WRITE_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
THREADS, TURNS, APPROVALS = {}, {}, {}
COUNTERS = {"thread": 0, "turn": 0, "approval": 0}
FAKE_SECRET = "mock-auth-secret-do-not-forward-1a2b3c4d"


def write(value):
    with WRITE_LOCK:
        print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)


def audit(value):
    if args.log:
        with args.log.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(value, ensure_ascii=False) + "\n")


def reply(request_id, result):
    write({"id": request_id, "result": result})


def notify(method, params):
    write({"method": method, "params": params})


def next_id(kind):
    with STATE_LOCK:
        COUNTERS[kind] += 1
        return f"mock-{kind}-{COUNTERS[kind]}"


def thread_value(thread_id):
    return {"id": thread_id, "preview": "Mock Codex thread", "ephemeral": True,
            "modelProvider": "openai", "createdAt": 1700000000, "updatedAt": 1700000000,
            "cwd": THREADS[thread_id]["cwd"], "status": {"type": "idle"},
            "source": "appServer", "turns": [], "path": None, "cliVersion": "mock"}


def thread_result(thread_id):
    return {"thread": thread_value(thread_id), "model": "mock-codex", "modelProvider": "openai",
            "cwd": THREADS[thread_id]["cwd"], "approvalPolicy": THREADS[thread_id].get("approval", "on-request"),
            "sandbox": ({"type": "readOnly", "networkAccess": False} if THREADS[thread_id].get("read_only") else {"type": "workspaceWrite", "writableRoots": [THREADS[thread_id]["cwd"]], "networkAccess": True}),
            "reasoningEffort": "medium"}


def turn_event(thread_id, turn_id, method, extra=None):
    payload = {"threadId": thread_id, "turnId": turn_id}
    payload.update(extra or {})
    notify(method, payload)


def item_event(thread_id, turn_id, item, completed=False):
    turn_event(thread_id, turn_id, "item/completed" if completed else "item/started", {"item": item})


def finish(thread_id, turn_id, text, status="completed"):
    state = TURNS.get(turn_id)
    if not state or state["finished"]:
        return
    state["finished"] = True
    if text:
        item_id = f"{turn_id}-message"
        item_event(thread_id, turn_id, {"id": item_id, "type": "agentMessage", "text": "", "phase": "final_answer"})
        midpoint = max(1, len(text) // 2)
        for delta in (text[:midpoint], text[midpoint:]):
            turn_event(thread_id, turn_id, "item/agentMessage/delta", {"itemId": item_id, "delta": delta})
        item_event(thread_id, turn_id, {"id": item_id, "type": "agentMessage", "text": text, "phase": "final_answer"}, True)
    notify("turn/completed", {"threadId": thread_id, "turn": {"id": turn_id, "items": [], "status": status, "error": None}})


def run_turn(thread_id, turn_id, task):
    cwd = THREADS[thread_id]["cwd"]
    time.sleep(.03)
    if "delayed-blocking" in task:
        time.sleep(1)
    if "mock:metadata" in task:
        notify("account/updated", {"authMode": "chatgpt", "access_token": FAKE_SECRET, "refresh_token": FAKE_SECRET})
        finish(thread_id, turn_id, "METADATA_FILTERED")
        return
    if "mock:crash" in task:
        time.sleep(.2)
        os._exit(0)
    if "mock:input" in task:
        request_id = next_id("approval")
        pending = {"event": threading.Event(), "result": None, "turn": turn_id}
        APPROVALS[request_id] = pending
        write({"id": request_id, "method": "item/tool/requestUserInput", "params": {
            "threadId": thread_id, "turnId": turn_id, "itemId": f"{turn_id}-input",
            "questions": [{"id": "destination", "header": "Файл", "question": "Какой файл использовать?",
                           "isOther": True, "isSecret": False, "options": [
                               {"label": "answer.rs", "description": "Rust"},
                               {"label": "answer.py", "description": "Python"}]}]}})
        pending["event"].wait(30)
        if not TURNS[turn_id]["finished"]:
            answers = (pending["result"] or {}).get("answers", {}).get("destination", {}).get("answers", [])
            finish(thread_id, turn_id, "INPUT_" + "|".join(answers))
        return
    if "mock:approval" in task:
        request_id = next_id("approval")
        pending = {"event": threading.Event(), "result": None, "turn": turn_id}
        APPROVALS[request_id] = pending
        method = "item/fileChange/requestApproval" if "file" in task else "item/commandExecution/requestApproval"
        write({"id": request_id, "method": method, "params": {
            "threadId": thread_id, "turnId": turn_id, "itemId": f"{turn_id}-approval",
            "command": "mock-command", "cwd": cwd, "reason": "Explicit mock approval"}})
        pending["event"].wait(30)
        if TURNS[turn_id]["finished"]:
            return
        decision = (pending["result"] or {}).get("decision", "missing")
        finish(thread_id, turn_id, "APPROVAL_" + str(decision).upper())
        return
    if "mock:abort" in task:
        item_event(thread_id, turn_id, {"id": f"{turn_id}-wait", "type": "commandExecution",
                                       "command": "mock wait", "cwd": cwd, "status": "inProgress", "aggregatedOutput": ""})
        TURNS[turn_id]["cancel"].wait(30)
        if not TURNS[turn_id]["finished"]:
            finish(thread_id, turn_id, "", "interrupted")
        return
    if "mock:tools" in task or "mock:code" in task:
        item_id = f"{turn_id}-command"
        item = {"id": item_id, "type": "commandExecution", "command": "python -c print(42)",
                "cwd": cwd, "status": "inProgress", "commandActions": [], "aggregatedOutput": ""}
        item_event(thread_id, turn_id, item)
        turn_event(thread_id, turn_id, "item/commandExecution/outputDelta", {"itemId": item_id, "delta": "42\n"})
        item.update(status="completed", aggregatedOutput="42\n", exitCode=0, durationMs=3)
        item_event(thread_id, turn_id, item, True)
        diff = "*** Begin Patch\n*** Add File: answer.rs\n+fn main() { println!(\"42\"); }\n*** End Patch"
        item_event(thread_id, turn_id, {"id": f"{turn_id}-file", "type": "fileChange", "status": "completed",
                                       "changes": [{"path": str(Path(cwd) / "answer.rs"), "kind": {"type": "add"}, "diff": diff}]}, True)
        item_event(thread_id, turn_id, {"id": f"{turn_id}-web", "type": "webSearch", "query": "Rust official documentation",
                                       "action": {"type": "search", "query": "Rust official documentation",
                                                  "queries": ["Rust official documentation"]}}, True)
        fence = chr(96) * 3
        finish(thread_id, turn_id, '## Готово\n\n' + fence + 'rust filename="answer.rs"\nfn main() { println!("42"); }\n' + fence + '\n\nПроверка завершилась с кодом 0.')
        return
    if "mock:parallel" in task:
        item_event(thread_id, turn_id, {"id": f"{turn_id}-work", "type": "commandExecution",
                                       "command": "mock parallel", "cwd": cwd, "status": "inProgress", "aggregatedOutput": ""})
        time.sleep(1.5 if "slow" in task else .35)
        finish(thread_id, turn_id, f"PARALLEL_RESULT {task}")
        return
    finish(thread_id, turn_id, "## Codex mock\n\nПолучено: " + task)


def dispatch(message):
    if "method" not in message:
        pending = APPROVALS.get(str(message.get("id")))
        if pending:
            pending["result"] = message.get("result")
            pending["event"].set()
        return
    method, params, request_id = message["method"], message.get("params") or {}, message.get("id")
    if method == "initialize":
        if args.stall_initialize:
            return
        if not params.get("capabilities", {}).get("requiredHumanApproval"):
            write({"id": request_id, "error": {"code": -32602, "message": "requiredHumanApproval was not enabled"}})
        else:
            reply(request_id, {"userAgent": "pilot-mock/1.0", "platformFamily": "windows", "platformOs": "windows"})
    elif method == "initialized":
        pass
    elif method == "account/read":
        reply(request_id, {"account": {"type": args.account_mode, "access_token": FAKE_SECRET}, "requiresOpenaiAuth": True})
    elif method == "model/list":
        second = params.get("cursor") == "page-2"
        model = "mock-codex-second" if second else "mock-codex"
        reply(request_id, {"data": [{"id": model, "model": model, "displayName": model, "description": "Offline fixture",
                                    "hidden": False, "isDefault": not second, "defaultReasoningEffort": "medium",
                                    "supportedReasoningEfforts": [{"reasoningEffort": "medium", "description": "Medium"},
                                                                 {"reasoningEffort": "high", "description": "High"}]}],
                           "nextCursor": None if second else "page-2"})
    elif method in ("thread/start", "thread/fork"):
        thread_id = next_id("thread")
        parent = THREADS.get(params.get("threadId"), {})
        THREADS[thread_id] = {"cwd": params.get("cwd") or parent.get("cwd") or str(Path.cwd()), "read_only": params.get("sandbox") == "read-only", "approval": params.get("approvalPolicy", "on-request")}
        reply(request_id, thread_result(thread_id))
        notify("thread/started", {"thread": thread_value(thread_id)})
    elif method == "turn/start":
        thread_id, turn_id = params["threadId"], next_id("turn")
        TURNS[turn_id] = {"thread": thread_id, "cancel": threading.Event(), "finished": False}
        task = "\n".join(str(item.get("text") or "") for item in params.get("input", []) if item.get("type") == "text")
        reply(request_id, {"turn": {"id": turn_id, "items": [], "status": "inProgress", "error": None}})
        notify("turn/started", {"threadId": thread_id, "turn": {"id": turn_id, "items": [], "status": "inProgress"}})
        threading.Thread(target=run_turn, args=(thread_id, turn_id, task), daemon=True).start()
    elif method == "turn/interrupt":
        if args.stall_interrupt:
            return
        turn_id = params["turnId"]
        state = TURNS.get(turn_id)
        reply(request_id, {})
        if state:
            state["cancel"].set()
            finish(state["thread"], turn_id, "", "interrupted")
    elif method == "test/slow":
        def delayed():
            time.sleep(float(params.get("delay", .1)))
            reply(request_id, {"value": params.get("value")})
        threading.Thread(target=delayed, daemon=True).start()
    elif method == "test/exit":
        raise SystemExit(0)
    else:
        if request_id is not None:
            write({"id": request_id, "error": {"code": -32601, "message": "Unsupported mock method"}})


audit({"_fixture_pid": os.getpid()})
for line in sys.stdin:
    try:
        message = json.loads(line)
        audit(message)
        dispatch(message)
    except (ValueError, KeyError, TypeError):
        print("mock protocol error", file=sys.stderr, flush=True)
