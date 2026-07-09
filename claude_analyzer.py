#!/usr/bin/env python3
"""
AI Tools Unified Analyzer  v3
Targets the exact folder layout confirmed on this machine:

  Claude Desktop   ~/.config/Claude/claude-code-sessions/
                   ~/.config/Claude/local-agent-mode-sessions/
  Claude Code CLI  ~/.claude/projects/
  Gemini CLI       ~/.gemini/history/
  Antigravity IDE  ~/.gemini/antigravity-ide/conversations/
  Antigravity CLI  ~/.gemini/antigravity-cli/
  Codex            ~/.codex/sessions/2026/
                   ~/.codex/memories/
  Puku CLI         ~/.puku-cli/projects/

Usage
-----
  python3 claude_analyzer.py                        # auto-detect all
  python3 claude_analyzer.py --chatgpt ~/Downloads/conversations.json
  python3 claude_analyzer.py -o report.html
"""

import json, os, re, sys, argparse
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
#  HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def parse_ts(ts) -> Optional[str]:
    if ts is None:
        return None
    try:
        if isinstance(ts, (int, float)):
            if ts > 1e12:           # milliseconds
                ts /= 1000.0
            return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        s = str(ts).strip().replace("Z", "+00:00")
        datetime.fromisoformat(s)
        return s
    except Exception:
        return None


def read_json(path: Path):
    try:
        return json.loads(path.read_text(errors="replace"))
    except Exception:
        return None


def read_jsonl(path: Path) -> list[dict]:
    out = []
    try:
        for line in path.read_text(errors="replace").splitlines():
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    except Exception:
        pass
    return out


def extract_text(val) -> str:
    if isinstance(val, str):
        return val
    if isinstance(val, list):
        return " ".join(extract_text(x) for x in val if x)
    if isinstance(val, dict):
        return extract_text(val.get("text") or val.get("content") or val.get("value") or "")
    return ""


def shorten(path: str, n: int = 55) -> str:
    if len(path) <= n:
        return path
    parts = Path(path).parts
    return "…/" + "/".join(parts[-2:]) if len(parts) >= 2 else path


def fmt(n) -> str:
    n = n or 0
    if n >= 1_000_000: return f"{n/1_000_000:.1f}M"
    if n >= 1_000:     return f"{n/1_000:.1f}K"
    return str(int(n))


# ─────────────────────────────────────────────────────────────────────────────
#  NORMALIZED EVENT / SESSION SCHEMA
# ─────────────────────────────────────────────────────────────────────────────

ESRC = ("source","t","ts","sid","len","inp","out","cr","cw","model","tools","thinking","cwd","ep","mcp")
SSRC = ("source","id","start_ts","end_ts","user_turns","assistant_turns",
        "input_tokens","output_tokens","cache_read","cache_create","thinking_count","tools_used",
        "models","cwd","entrypoint","first_message","title")

def ev(**kw)  -> dict: return {k: kw.get(k, "") for k in ESRC}
def sess(**kw)-> dict:
    s = {k: kw.get(k) for k in SSRC}
    # use-or-default: replaces None left by kw.get for collection/counter fields
    s["tools_used"]      = s.get("tools_used")      or {}
    s["models"]          = s.get("models")          or []
    s["user_turns"]      = s.get("user_turns")      or 0
    s["assistant_turns"] = s.get("assistant_turns") or 0
    return s


def _update_ts(s: dict, ts: Optional[str]):
    if not ts: return
    if not s["start_ts"] or ts < s["start_ts"]: s["start_ts"] = ts
    if not s["end_ts"]   or ts > s["end_ts"]:   s["end_ts"]   = ts


# ─────────────────────────────────────────────────────────────────────────────
#  CLAUDE PARSER  (Desktop + CLI share the same JSONL schema)
# ─────────────────────────────────────────────────────────────────────────────

def parse_claude(roots: list[Path]) -> tuple[list, list]:
    """
    Scans all *.jsonl under the given roots.
    Works for both:
      ~/.config/Claude/claude-code-sessions/
      ~/.config/Claude/local-agent-mode-sessions/
      ~/.claude/projects/
    """
    events, sd = [], {}

    jsonl_files = []
    for root in roots:
        jsonl_files.extend(root.rglob("*.jsonl"))

    for path in sorted(set(jsonl_files)):
        file_sid = None
        for rec in read_jsonl(path):
            rtype = rec.get("type", "")
            sid   = rec.get("sessionId", "") or file_sid or path.stem
            file_sid = sid

            if sid not in sd:
                sd[sid] = sess(source="claude", id=sid)

            s  = sd[sid]
            ts = parse_ts(rec.get("timestamp"))
            _update_ts(s, ts)

            if rtype == "user":
                s["user_turns"] = (s["user_turns"] or 0) + 1
                cwd = rec.get("cwd", "")
                ep  = rec.get("entrypoint", "")
                if cwd and not s["cwd"]:  s["cwd"]       = cwd
                if ep  and not s["entrypoint"]: s["entrypoint"] = ep
                text = extract_text(rec.get("message", {}).get("content", "")).strip()
                if text and not s["first_message"]:
                    s["first_message"] = text[:200]
                events.append(ev(source="claude", t="user", ts=ts, sid=sid,
                                 len=len(text), cwd=cwd, ep=ep))

            elif rtype == "assistant":
                s["assistant_turns"] = (s["assistant_turns"] or 0) + 1
                msg   = rec.get("message", {})
                model = msg.get("model", "")
                if not s["models"]: s["models"] = []
                if model and model not in s["models"]:
                    s["models"].append(model)

                usage = msg.get("usage", {})
                inp = usage.get("input_tokens", 0)
                out = usage.get("output_tokens", 0)
                cr  = usage.get("cache_read_input_tokens", 0)
                cw  = usage.get("cache_creation_input_tokens", 0)
                s["input_tokens"]  = (s["input_tokens"]  or 0) + inp
                s["output_tokens"] = (s["output_tokens"] or 0) + out
                s["cache_read"]    = (s["cache_read"]    or 0) + cr
                s["cache_create"]  = (s["cache_create"]  or 0) + cw

                if not s["tools_used"]: s["tools_used"] = {}
                tools_turn, thinking = [], 0
                for blk in (msg.get("content") or []):
                    if isinstance(blk, dict):
                        if blk.get("type") == "tool_use":
                            tn = blk.get("name", "unknown")
                            tools_turn.append(tn)
                            s["tools_used"][tn] = s["tools_used"].get(tn, 0) + 1
                        elif blk.get("type") == "thinking":
                            thinking += 1
                            s["thinking_count"] = (s["thinking_count"] or 0) + 1

                events.append(ev(source="claude", t="assistant", ts=ts, sid=sid,
                                 inp=inp, out=out, cr=cr, cw=cw, model=model,
                                 tools=tools_turn, thinking=thinking,
                                 mcp=rec.get("attributionMcpServer","") or "",
                                 ep=s["entrypoint"] or "", cwd=s["cwd"] or ""))

            elif rtype == "last-prompt":
                if not s["title"]:
                    s["title"] = rec.get("lastPrompt","")[:200]

    return events, list(sd.values())


# ─────────────────────────────────────────────────────────────────────────────
#  GEMINI CLI PARSER  (~/.gemini/tmp/<project>/chats/session-*.jsonl)
#
#  NOTE: ~/.gemini/history/ is a *file-checkpoint* tree, NOT conversations.
#  Real chat logs live under tmp/<project>/chats/ as JSONL, one file per chat:
#    line 0  {"sessionId","projectHash","startTime","lastUpdated","kind"}
#    user    {"id","timestamp","type":"user","content":[{"text":...}]}
#    gemini  {"id","timestamp","type":"gemini","content":"...","thoughts":[...]}
#    meta    {"$set":{"lastUpdated":...}}                       ← ignore
#    info    {"id","timestamp","type":"info","content":...}     ← ignore
#  The project folder name (tmp/<project>/) is used as the cwd/project label.
# ─────────────────────────────────────────────────────────────────────────────

def parse_gemini(root: Path) -> tuple[list, list]:
    events, sessions = [], []
    tmp_dir = root / "tmp"
    if not tmp_dir.is_dir():
        return events, sessions

    for path in sorted(tmp_dir.glob("*/chats/*.jsonl")):
        project = path.parent.parent.name      # tmp/<project>/chats/file.jsonl
        _parse_gemini_chat(path, project, events, sessions)

    return events, sessions


def _parse_gemini_chat(path: Path, project: str, events: list, sessions: list):
    recs = read_jsonl(path)
    if not recs:
        return

    sid = path.stem
    s   = sess(source="gemini", id=sid, cwd=project)
    uturn = aturn = 0

    for rec in recs:
        if not isinstance(rec, dict):
            continue

        # session-meta line (first record)
        if "sessionId" in rec and "type" not in rec:
            sid = rec.get("sessionId") or sid
            s["id"] = sid
            _update_ts(s, parse_ts(rec.get("startTime")))
            _update_ts(s, parse_ts(rec.get("lastUpdated")))
            continue

        rtype = rec.get("type", "")
        ts    = parse_ts(rec.get("timestamp"))
        _update_ts(s, ts)

        if rtype == "user":
            text = extract_text(rec.get("content")).strip()
            uturn += 1
            if text and not s["first_message"]:
                s["first_message"] = text[:200]
            events.append(ev(source="gemini", t="user", ts=ts, sid=sid,
                             len=len(text), cwd=project))

        elif rtype == "gemini":
            text = extract_text(rec.get("content")).strip()
            thoughts = rec.get("thoughts") or []
            thinking = len(thoughts) if isinstance(thoughts, list) else 0
            if thinking:
                s["thinking_count"] = (s["thinking_count"] or 0) + thinking
            m = rec.get("model", "") or "gemini"
            if m not in s["models"]:
                s["models"].append(m)
            aturn += 1
            events.append(ev(source="gemini", t="assistant", ts=ts, sid=sid,
                             out=len(text), model=m, thinking=thinking,
                             cwd=project))
        # "$set" / "info" / other → ignore

    if not s["models"]:
        s["models"] = ["gemini"]
    s["user_turns"]      = uturn
    s["assistant_turns"] = aturn
    if uturn + aturn > 0:
        sessions.append(s)


# ─────────────────────────────────────────────────────────────────────────────
#  ANTIGRAVITY PARSER
#
#  Antigravity (IDE + CLI) stores conversations as opaque protobuf .pb files in
#  antigravity-*/conversations/.  The readable record is the per-conversation
#  transcript at:
#      antigravity-{ide,cli}/brain/<convId>/.system_generated/logs/transcript.jsonl
#  Each line is a "step":
#    {source, type, status, created_at, content?, thinking?}
#  Mapping:
#    USER_EXPLICIT / USER_INPUT                     → user turn
#    MODEL         / PLANNER_RESPONSE               → assistant turn (+thinking)
#    MODEL         / {VIEW_FILE,CODE_ACTION,RUN_COMMAND,GREP_SEARCH,
#                     LIST_DIRECTORY,SEARCH_WEB,READ_URL_CONTENT,...}  → tool call
#    SYSTEM        / *                              → ignore (ephemeral/system)
# ─────────────────────────────────────────────────────────────────────────────

# step types the model emits that we treat as tool calls
_AG_TOOL_TYPES = {
    "VIEW_FILE", "CODE_ACTION", "RUN_COMMAND", "GREP_SEARCH", "LIST_DIRECTORY",
    "SEARCH_WEB", "READ_URL_CONTENT", "ASK_QUESTION", "EDIT_FILE", "WRITE_FILE",
    "BROWSER", "MEMORY",
}

def _ag_workspace_map(gemini_root: Path) -> dict:
    """conversationId → workspace path, from CLI history + cache files."""
    m = {}
    for sub in ("antigravity-cli", "antigravity-ide"):
        base = gemini_root / sub
        hist = base / "history.jsonl"
        if hist.is_file():
            for rec in read_jsonl(hist):
                cid, ws = rec.get("conversationId"), rec.get("workspace")
                if cid and ws:
                    m[cid] = ws
        cache = base / "cache" / "last_conversations.json"
        data = read_json(cache)
        if isinstance(data, dict):
            for ws, cid in data.items():
                if cid and ws:
                    m.setdefault(cid, ws)
    return m


def parse_antigravity(gemini_root: Path) -> tuple[list, list]:
    events, sessions = [], []
    ws_map = _ag_workspace_map(gemini_root)

    for sub in ("antigravity-cli", "antigravity-ide"):
        brain = gemini_root / sub / "brain"
        if not brain.is_dir():
            continue
        for conv_dir in sorted(p for p in brain.iterdir() if p.is_dir()):
            tpath = conv_dir / ".system_generated" / "logs" / "transcript.jsonl"
            if tpath.is_file():
                _parse_ag_transcript(tpath, conv_dir.name, ws_map.get(conv_dir.name, ""),
                                     events, sessions)

    return events, sessions


def _ag_clean(text: str) -> str:
    # strip the <USER_REQUEST> / metadata wrappers for the title preview
    m = re.search(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", text, re.DOTALL)
    return (m.group(1) if m else text).strip()


def _parse_ag_transcript(path: Path, cid: str, workspace: str,
                         events: list, sessions: list):
    recs = read_jsonl(path)
    if not recs:
        return

    s = sess(source="antigravity", id=cid, cwd=workspace, models=["gemini"])
    uturn = aturn = 0

    for rec in recs:
        if not isinstance(rec, dict):
            continue
        src   = rec.get("source", "")
        rtype = rec.get("type", "")
        ts    = parse_ts(rec.get("created_at"))
        _update_ts(s, ts)

        if src == "USER_EXPLICIT" and rtype == "USER_INPUT":
            text = _ag_clean(extract_text(rec.get("content")))
            uturn += 1
            if text and not s["first_message"]:
                s["first_message"] = text[:200]
            events.append(ev(source="antigravity", t="user", ts=ts, sid=cid,
                             len=len(text), cwd=workspace))

        elif src == "MODEL" and rtype == "PLANNER_RESPONSE":
            text = extract_text(rec.get("content")).strip()
            thinking = 1 if rec.get("thinking") else 0
            if thinking:
                s["thinking_count"] = (s["thinking_count"] or 0) + 1
            aturn += 1
            events.append(ev(source="antigravity", t="assistant", ts=ts, sid=cid,
                             out=len(text), model="gemini", thinking=thinking,
                             cwd=workspace))

        elif src == "MODEL" and rtype in _AG_TOOL_TYPES:
            s["tools_used"][rtype] = s["tools_used"].get(rtype, 0) + 1
            events.append(ev(source="antigravity", t="assistant", ts=ts, sid=cid,
                             model="gemini", tools=[rtype], cwd=workspace))
        # SYSTEM/* and user-performed actions → ignore

    s["user_turns"]      = uturn
    s["assistant_turns"] = aturn
    if uturn + aturn > 0:
        sessions.append(s)


# ─────────────────────────────────────────────────────────────────────────────
#  CHATGPT EXPORT PARSER  (conversations.json from chat.openai.com)
# ─────────────────────────────────────────────────────────────────────────────

def parse_chatgpt(files: list[Path]) -> tuple[list, list]:
    events, sessions = [], []

    for path in files:
        data = read_json(path)
        if not isinstance(data, list):
            if isinstance(data, dict):
                data = data.get("conversations", [data])
            else:
                continue

        for conv in data:
            if not isinstance(conv, dict):
                continue
            sid   = conv.get("id","")
            title = conv.get("title","")
            c_ts  = parse_ts(conv.get("create_time"))
            u_ts  = parse_ts(conv.get("update_time"))

            s = sess(source="chatgpt", id=sid, title=title, start_ts=c_ts, end_ts=u_ts)
            uturn = aturn = 0
            models_seen = set()

            for node in (conv.get("mapping") or {}).values():
                if not isinstance(node, dict):
                    continue
                msg = node.get("message")
                if not msg or not isinstance(msg, dict):
                    continue
                role  = (msg.get("author") or {}).get("role","")
                ts    = parse_ts(msg.get("create_time"))
                ct    = msg.get("content") or {}
                parts = ct.get("parts") or ct.get("text") or []
                text  = extract_text(parts).strip()
                meta  = msg.get("metadata") or {}
                model = (meta.get("model_slug") or meta.get("model")
                         or msg.get("model_slug") or "")

                if not text or role in ("system","tool"):
                    continue
                if model:
                    models_seen.add(model)

                if role == "user":
                    uturn += 1
                    if not s["first_message"]:
                        s["first_message"] = text[:200]
                    events.append(ev(source="chatgpt", t="user", ts=ts, sid=sid, len=len(text)))
                elif role == "assistant":
                    aturn += 1
                    events.append(ev(source="chatgpt", t="assistant", ts=ts, sid=sid,
                                     model=model, out=len(text)))

            s["user_turns"]      = uturn
            s["assistant_turns"] = aturn
            s["models"]          = list(models_seen)
            if uturn + aturn > 0:
                sessions.append(s)

    return events, sessions


# ─────────────────────────────────────────────────────────────────────────────
#  CODEX CLI PARSER  (~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl)
#
#  Every record is wrapped: {"timestamp","type","payload":{...}}.
#  Record types:
#    session_meta   payload:{id,cwd,timestamp,model_provider,...}
#    turn_context   payload:{cwd,model,...}                     ← model lives here
#    event_msg      payload:{type:...}                          ← runtime events (ignore)
#    response_item  payload:{type:...}:
#        message        role user/assistant/developer, content:[{type,text}]
#                       (input_text / output_text)
#        reasoning      → thinking block (often encrypted)
#        function_call / custom_tool_call / local_shell_call    → tool call
#        *_output       → ignore
#  Injected user messages (<environment_context>/<permissions instructions>)
#  are filtered out of the user-turn count.
# ─────────────────────────────────────────────────────────────────────────────

_CODEX_TOOL_TYPES = {"function_call", "custom_tool_call", "local_shell_call"}
_CODEX_INJECTED   = ("<environment_context>", "<permissions instructions>",
                     "<user_instructions>")

def parse_codex(root: Path) -> tuple[list, list]:
    events, sessions = [], []
    sess_dir = root / "sessions"
    files = sorted(sess_dir.rglob("*.jsonl")) if sess_dir.is_dir() else []
    for path in files:
        _parse_codex_file(path, events, sessions)
    return events, sessions


def _parse_codex_file(path: Path, events: list, sessions: list):
    recs = read_jsonl(path)
    if not recs:
        return

    sid   = path.stem
    s     = sess(source="codex", id=sid)
    model = ""
    uturn = aturn = 0

    for rec in recs:
        if not isinstance(rec, dict):
            continue
        rtype = rec.get("type", "")
        p     = rec.get("payload", {})
        if not isinstance(p, dict):
            continue
        ts = parse_ts(rec.get("timestamp") or p.get("timestamp"))
        _update_ts(s, ts)

        if rtype == "session_meta":
            sid = p.get("id") or sid
            s["id"] = sid
            if p.get("cwd") and not s["cwd"]:
                s["cwd"] = p["cwd"]
            s["entrypoint"] = p.get("originator", "") or s["entrypoint"]
            continue

        if rtype == "turn_context":
            m = p.get("model", "")
            if m:
                model = m
                if m not in s["models"]:
                    s["models"].append(m)
            if p.get("cwd") and not s["cwd"]:
                s["cwd"] = p["cwd"]
            continue

        if rtype != "response_item":
            continue   # event_msg etc.

        ptype = p.get("type", "")

        if ptype == "message":
            role = p.get("role", "")
            text = extract_text(p.get("content")).strip()
            if role == "user":
                if text.startswith(_CODEX_INJECTED):
                    continue   # system-injected context, not a real prompt
                uturn += 1
                if text and not s["first_message"]:
                    s["first_message"] = text[:200]
                events.append(ev(source="codex", t="user", ts=ts, sid=sid,
                                 len=len(text), cwd=s["cwd"] or ""))
            elif role == "assistant":
                aturn += 1
                events.append(ev(source="codex", t="assistant", ts=ts, sid=sid,
                                 out=len(text), model=model, cwd=s["cwd"] or ""))
            # role == "developer" → system prompt, ignore

        elif ptype == "reasoning":
            s["thinking_count"] = (s["thinking_count"] or 0) + 1
            events.append(ev(source="codex", t="assistant", ts=ts, sid=sid,
                             model=model, thinking=1, cwd=s["cwd"] or ""))

        elif ptype in _CODEX_TOOL_TYPES:
            tool_name = p.get("name", "") or ptype
            s["tools_used"][tool_name] = s["tools_used"].get(tool_name, 0) + 1
            events.append(ev(source="codex", t="assistant", ts=ts, sid=sid,
                             model=model, tools=[tool_name], cwd=s["cwd"] or ""))

    if not s["models"]:
        s["models"] = ["codex"]
    s["user_turns"]      = uturn
    s["assistant_turns"] = aturn
    if uturn + aturn > 0:
        sessions.append(s)


# ─────────────────────────────────────────────────────────────────────────────
#  PUKU CLI PARSER  (~/.puku-cli/projects/<encoded-cwd>/<sid>.jsonl)
#
#  Every line is a single record with top-level sessionId, cwd, entrypoint,
#  timestamp, slug (human-friendly name), gitBranch, isMeta.  Messages live in
#  record.message (Anthropic-compatible shape):
#      user / assistant messages use the same content-block schema as
#      Claude Code ({"type":"text"|"tool_use", ...}).
#  Other record types:
#    last-prompt         {type, lastPrompt, sessionId}        ← topic/title
#    system              turn duration etc.                   ← ignore
#    queue-operation     session queue bookkeeping            ← ignore
#    file-history-snapshot                                    ← ignore
#
#  Puku routes to multiple model providers, so record.message.model may be a
#  Claude family, a third-party model (e.g. "MiniMax-M3"), or "<synthetic>"
#  for the local/synthetic harness.  We capture whatever shows up.
#  isMeta user records (e.g. <local-command-caveat>, /login, /model) are
#  injected by the harness — counted as system context, not user prompts.
# ─────────────────────────────────────────────────────────────────────────────

def parse_puku(root: Path) -> tuple[list, list]:
    """Scan every *.jsonl under ~/.puku-cli/projects/<project>/[subagents/]."""
    events, sessions = [], []
    if not root.is_dir():
        return events, sessions

    jsonl_files = sorted(root.rglob("*.jsonl"))
    for path in jsonl_files:
        _parse_puku_file(path, events, sessions)

    return events, sessions


def _parse_puku_file(path: Path, events: list, sessions: list):
    recs = read_jsonl(path)
    if not recs:
        return

    sid   = path.stem
    s     = sess(source="puku", id=sid)
    uturn = aturn = 0

    for rec in recs:
        if not isinstance(rec, dict):
            continue
        rtype = rec.get("type", "")
        ts    = parse_ts(rec.get("timestamp"))
        _update_ts(s, ts)

        # Pick up session-level bookkeeping from any record.
        if not s["cwd"] and rec.get("cwd"):
            s["cwd"] = rec["cwd"]
        if not s["entrypoint"] and rec.get("entrypoint"):
            s["entrypoint"] = rec["entrypoint"]
        s_cwd, s_ep = s["cwd"] or "", s["entrypoint"] or ""

        # ── last-prompt → topic / title (matches Claude schema) ──
        if rtype == "last-prompt":
            if not s["title"]:
                lp = rec.get("lastPrompt", "")
                if lp:
                    s["title"] = lp[:200]

        # ── user ──
        elif rtype == "user":
            # isMeta = injected by harness (e.g. /login, /model) → not a real prompt.
            if rec.get("isMeta"):
                continue
            content = rec.get("message", {}).get("content", "")
            text    = extract_text(content).strip()
            # <command-name> / <local-command-*> tags are still harness-injected.
            if text.startswith("<command-name>") or text.startswith("<local-command-"):
                continue
            uturn += 1
            if text and not s["first_message"]:
                s["first_message"] = text[:200]
            events.append(ev(source="puku", t="user", ts=ts, sid=sid,
                             len=len(text), cwd=s_cwd, ep=s_ep))

        # ── assistant ──
        elif rtype == "assistant":
            msg   = rec.get("message", {}) or {}
            model = msg.get("model", "")
            if model and model not in s["models"]:
                s["models"].append(model)

            usage = msg.get("usage", {}) or {}
            inp = usage.get("input_tokens", 0) or 0
            out = usage.get("output_tokens", 0) or 0
            cr  = usage.get("cache_read_input_tokens", 0) or 0
            cw  = usage.get("cache_creation_input_tokens", 0) or 0
            s["input_tokens"]  = (s["input_tokens"]  or 0) + inp
            s["output_tokens"] = (s["output_tokens"] or 0) + out
            s["cache_read"]    = (s["cache_read"]    or 0) + cr
            s["cache_create"]  = (s["cache_create"]  or 0) + cw

            aturn += 1
            tools_turn, thinking = [], 0
            for blk in (msg.get("content") or []):
                if not isinstance(blk, dict):
                    continue
                btype = blk.get("type", "")
                if btype == "tool_use":
                    tn = blk.get("name", "unknown")
                    tools_turn.append(tn)
                    s["tools_used"][tn] = s["tools_used"].get(tn, 0) + 1
                elif btype == "thinking":
                    thinking += 1
                    s["thinking_count"] = (s["thinking_count"] or 0) + 1

            events.append(ev(source="puku", t="assistant", ts=ts, sid=sid,
                             inp=inp, out=out, cr=cr, cw=cw, model=model,
                             tools=tools_turn, thinking=thinking,
                             cwd=s_cwd, ep=s_ep))

        # system / queue-operation / file-history-snapshot → ignore

    if not s["models"]:
        s["models"] = ["puku-cli"]
    s["user_turns"]      = uturn
    s["assistant_turns"] = aturn
    if uturn + aturn > 0:
        sessions.append(s)


# ─────────────────────────────────────────────────────────────────────────────
#  MEMORY (Claude Cowork + Codex ~/.codex/memories/)
# ─────────────────────────────────────────────────────────────────────────────

def find_memory_files(roots: list[Path]) -> list[Path]:
    files = []
    for root in roots:
        for md in root.rglob("*.md"):
            try:
                text = md.read_text(errors="ignore")[:500]
                if any(f"type: {t}" in text for t in ("user","feedback","project","reference")):
                    files.append(md)
            except Exception:
                pass
    return files


def analyze_memory(files: list[Path]) -> dict:
    out: dict[str, list] = {}
    for f in files:
        try:
            text = f.read_text(errors="ignore")
            m_type = next((t for t in ("user","feedback","project","reference")
                           if f"type: {t}" in text[:300]), "other")
            nm = re.search(r"^name:\s*(.+)$", text, re.MULTILINE)
            ds = re.search(r"^description:\s*(.+)$", text, re.MULTILINE)
            out.setdefault(m_type, []).append({
                "file": f.name,
                "name": nm.group(1).strip() if nm else f.stem,
                "description": ds.group(1).strip() if ds else "",
            })
        except Exception:
            pass
    return out


def analyze_settings(roots: list[Path]) -> list[dict]:
    result = []
    for root in roots:
        for name in ("settings.json","settings.local.json",".claude.json"):
            p = root / name
            if p.exists():
                try:
                    result.append({"file": str(p), "data": json.loads(p.read_text())})
                except Exception:
                    pass
    return result


# ─────────────────────────────────────────────────────────────────────────────
#  HTML DASHBOARD
# ─────────────────────────────────────────────────────────────────────────────

SOURCE_COLORS = {
    "claude":       "#6c63ff",
    "gemini":       "#1a73e8",
    "antigravity":  "#00c4b4",
    "chatgpt":      "#10a37f",
    "codex":        "#f97316",
    "puku":         "#e879f9",
}
SOURCE_LABELS = {
    "claude":       "Claude",
    "gemini":       "Gemini CLI",
    "antigravity":  "Antigravity",
    "chatgpt":      "ChatGPT",
    "codex":        "Codex",
    "puku":         "Puku CLI",
}


def build_html(all_events, all_sessions, memory_data, settings_data,
               scan_info, generated_at) -> str:

    total_ev = sum(v.get("events",0) for v in scan_info.get("sources",{}).values())

    # ── static sections ──────────────────────────────────────────────────────
    mem_html = ""
    for mtype, entries in memory_data.items():
        if not entries: continue
        rows = "".join(f"<tr><td><b>{e['name']}</b></td><td>{e['description']}</td></tr>"
                       for e in entries)
        mem_html += f"""<div class="msec"><h4 class="mtype">{mtype.upper()} ({len(entries)})</h4>
          <table class="dt"><thead><tr><th>Name</th><th>Description</th></tr></thead>
          <tbody>{rows}</tbody></table></div>"""
    if not mem_html:
        mem_html = "<p class='nd'>No memory files found.</p>"

    settings_html = "".join(
        f"<p class='sf'>{s['file']}</p><pre class='sp'><code>{json.dumps(s['data'],indent=2)[:3000]}</code></pre>"
        for s in settings_data
    ) or "<p class='nd'>No settings files found.</p>"

    scan_rows = ""
    for src, info in scan_info.get("sources",{}).items():
        col = SOURCE_COLORS.get(src,"#888")
        lbl = SOURCE_LABELS.get(src, src)
        scan_rows += (f"<tr><td><span class='badge' style='background:{col}'>{lbl}</span></td>"
                      f"<td>{fmt(info.get('events',0))} events &nbsp; {fmt(info.get('sessions',0))} sessions</td>"
                      f"<td class='trunc' title='{info.get('path','')}'>{shorten(info.get('path',''),60)}</td></tr>")

    sources_present = sorted(set(e["source"] for e in all_events if e.get("source")))
    src_btns = "".join(
        '<button class="src-btn" data-src="{s}" onclick="setSrc(\'{s}\',this)" '
        'style="--sc:{col}">{lbl}</button>'.format(
            s=s, col=SOURCE_COLORS.get(s,"#888"), lbl=SOURCE_LABELS.get(s,s))
        for s in sources_present
    )

    ev_json   = json.dumps(all_events)
    sess_json = json.dumps(all_sessions)
    col_json  = json.dumps(SOURCE_COLORS)
    lbl_json  = json.dumps(SOURCE_LABELS)

    total_mem = sum(len(v) for v in memory_data.values())

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AI Tools Analyzer</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
:root{{--bg:#0f1117;--s1:#1a1d2e;--s2:#252840;--bd:#2e3250;
  --acc:#6c63ff;--pk:#ff6584;--gr:#43e97b;--gold:#ffd700;
  --bl:#1a73e8;--tl:#10a37f;--or:#f97316;--cy:#00c4b4;
  --tx:#e0e0f0;--mt:#8890b0}}
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:var(--bg);color:var(--tx);font-family:'Segoe UI',system-ui,sans-serif;font-size:14px}}
header{{background:linear-gradient(135deg,#1a1d2e,#252840);border-bottom:1px solid var(--bd);
  padding:16px 28px;display:flex;justify-content:space-between;align-items:center}}
header h1{{font-size:19px;font-weight:700}}
.brand{{color:var(--acc)}}
.subtitle{{color:var(--mt);font-size:11px;margin-top:3px}}
.gen{{color:var(--mt);font-size:11px;text-align:right;line-height:1.7}}

/* Filter bar */
.fbar{{background:var(--s1);border-bottom:1px solid var(--bd);
  padding:9px 28px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}}
.flbl{{color:var(--mt);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px}}
.pb,.src-btn{{padding:4px 14px;border-radius:20px;border:1px solid var(--bd);
  background:transparent;color:var(--mt);cursor:pointer;font-size:12px;font-weight:500;transition:all .15s}}
.pb:hover{{color:var(--tx);border-color:var(--acc)}}
.pb.active{{background:var(--acc);color:#fff;border-color:var(--acc)}}
.src-btn{{border-color:color-mix(in srgb,var(--sc,#555) 60%,transparent);color:var(--sc,#888)}}
.src-btn:hover,.src-btn.active{{background:var(--sc,#888);color:#fff;border-color:var(--sc,#888)}}
.all-src{{color:var(--mt)!important;border-color:var(--bd)!important}}
.all-src.active{{background:var(--s2)!important;color:var(--tx)!important;border-color:var(--mt)!important}}
.prlbl{{color:var(--mt);font-size:10px;margin-left:4px}}
.div{{width:1px;height:22px;background:var(--bd)}}

/* Container */
.wrap{{max-width:1440px;margin:0 auto;padding:16px 28px}}

/* KPIs */
.kpi-grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:10px;margin-bottom:18px}}
.kpi{{background:var(--s1);border:1px solid var(--bd);border-radius:10px;padding:14px 12px;transition:transform .15s,border-color .15s}}
.kpi:hover{{transform:translateY(-2px);border-color:var(--acc)}}
.kl{{color:var(--mt);font-size:9px;text-transform:uppercase;letter-spacing:.8px}}
.kv{{font-size:22px;font-weight:700;line-height:1.15;margin:3px 0 2px}}
.ks{{color:var(--mt);font-size:9px}}
.ca .kv{{color:var(--acc)}} .cg .kv{{color:var(--gr)}} .cgo .kv{{color:var(--gold)}}
.cp .kv{{color:var(--pk)}}  .cb .kv{{color:var(--bl)}} .ct .kv{{color:var(--tl)}}

/* Source chips */
.src-chips{{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}}
.chip{{padding:4px 12px;border-radius:7px;font-size:11px;font-weight:600;border:1px solid;display:flex;gap:8px;align-items:center}}

/* Grids */
.g1{{display:grid;grid-template-columns:1fr;gap:14px;margin-bottom:14px}}
.g2{{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}}
.g3{{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:14px}}
@media(max-width:900px){{.g2,.g3{{grid-template-columns:1fr}}}}

/* Card */
.card{{background:var(--s1);border:1px solid var(--bd);border-radius:10px;padding:15px}}
.card h3{{font-size:10px;font-weight:600;color:var(--mt);text-transform:uppercase;letter-spacing:.8px;
  margin-bottom:10px;padding-bottom:7px;border-bottom:1px solid var(--bd)}}
.card canvas{{max-height:230px}}

/* Tabs */
.tabs{{display:flex;gap:4px;margin-bottom:16px;flex-wrap:wrap}}
.tb{{padding:5px 13px;border-radius:7px;border:1px solid var(--bd);background:var(--s1);
  color:var(--mt);cursor:pointer;font-size:12px;font-weight:500;transition:all .15s}}
.tb:hover{{color:var(--tx);border-color:var(--acc)}}
.tb.active{{background:var(--acc);color:#fff;border-color:var(--acc)}}
.tp{{display:none}}.tp.active{{display:block}}

/* Table */
.dt{{width:100%;border-collapse:collapse;font-size:11px}}
.dt th{{text-align:left;color:var(--mt);padding:6px 9px;border-bottom:1px solid var(--bd);
  font-size:9px;text-transform:uppercase;letter-spacing:.5px}}
.dt td{{padding:6px 9px;border-bottom:1px solid var(--bd);vertical-align:top}}
.dt tr:last-child td{{border-bottom:none}}
.dt tr:hover td{{background:var(--s2)}}
.trunc{{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.tw{{overflow-x:auto}}
#ss{{width:100%;padding:6px 11px;border-radius:7px;border:1px solid var(--bd);
  background:var(--s2);color:var(--tx);font-size:12px;margin-bottom:8px;outline:none}}
#ss:focus{{border-color:var(--acc)}}

/* Heatmap */
.hm{{display:grid;grid-template-columns:repeat(24,1fr);gap:2px;margin-top:6px}}
.hmc{{height:26px;border-radius:3px;background:var(--s2);display:flex;align-items:center;
  justify-content:center;font-size:9px;color:var(--mt)}}

/* Memory */
.msec{{margin-bottom:14px}}
.mtype{{font-size:9px;color:var(--acc);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px}}
.sp{{background:var(--s2);border-radius:7px;padding:9px;overflow-x:auto;font-size:10px;color:var(--gr);margin:5px 0 12px;max-height:240px}}
.sf{{color:var(--mt);font-size:10px;margin-top:6px}}
.nd{{color:var(--mt);font-style:italic;padding:8px 0;font-size:12px}}
.badge{{display:inline-block;padding:2px 7px;border-radius:5px;color:#fff;font-size:10px;font-weight:600}}
/* Project activity */
.project-badge{{display:inline-block;padding:2px 9px;border-radius:5px;background:var(--s2);
  border:1px solid var(--bd);color:var(--tx);font-size:11px;font-weight:500}}
.dt tr.proj-row{{cursor:pointer;transition:background .1s}}
.dt tr.proj-row:hover td{{background:color-mix(in srgb,var(--acc) 12%,var(--s1))}}
.dt tr.proj-row.active-row td{{background:color-mix(in srgb,var(--acc) 18%,var(--s1));
  border-left:2px solid var(--acc)}}
.prompt-text{{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.pj-layout{{display:flex;gap:14px;align-items:stretch;height:600px}}
.pj-left{{flex:0 0 360px;min-width:0;display:flex;flex-direction:column}}
.pj-left .card{{flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0}}
.pj-left .card .tw{{flex:1;overflow-y:auto;min-height:0}}
.pj-right{{flex:1;min-width:0;display:none}}
.pj-right.open{{display:flex;flex-direction:column}}
.sess-detail-panel{{background:var(--s2);border:1px solid var(--bd);border-radius:10px;
  padding:14px;flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0}}
.sess-detail-panel .tw{{flex:1;overflow-y:auto;min-height:0}}
.sdh{{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-shrink:0}}
.sdh h4{{font-size:11px;font-weight:600;color:var(--mt);text-transform:uppercase;letter-spacing:.8px}}
.sdh button{{background:transparent;border:1px solid var(--bd);color:var(--mt);
  padding:2px 9px;border-radius:5px;cursor:pointer;font-size:10px}}
.sdh button:hover{{color:var(--tx);border-color:var(--acc)}}
@media(max-width:800px){{.pj-layout{{flex-direction:column;height:auto}}
  .pj-left{{flex:none;height:300px}}.pj-right.open{{height:400px}}}}
::-webkit-scrollbar{{width:4px;height:4px}}
::-webkit-scrollbar-track{{background:var(--s1)}}
::-webkit-scrollbar-thumb{{background:var(--bd);border-radius:3px}}
</style>
</head>
<body>

<header>
  <div>
    <h1><span class="brand">AI Tools</span> Analyzer</h1>
    <div class="subtitle">Claude &nbsp;·&nbsp; Gemini CLI &nbsp;·&nbsp; Antigravity &nbsp;·&nbsp; ChatGPT &nbsp;·&nbsp; Codex &nbsp;·&nbsp; Puku CLI</div>
  </div>
  <div class="gen">Generated: {generated_at}<br>{fmt(total_ev)} total events</div>
</header>

<div class="fbar">
  <div style="display:flex;align-items:center;gap:6px">
    <span class="flbl">Period</span>
    <button class="pb" onclick="setPeriod('today',this)">Today</button>
    <button class="pb" onclick="setPeriod('week',this)">This Week</button>
    <button class="pb" onclick="setPeriod('month',this)">This Month</button>
    <button class="pb active" onclick="setPeriod('all',this)">All Time</button>
    <span class="prlbl" id="pr"></span>
  </div>
  <div class="div"></div>
  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
    <span class="flbl">Source</span>
    <button class="src-btn all-src active" onclick="setSrc('all',this)">All</button>
    {src_btns}
  </div>
</div>

<div class="wrap">

  <div class="kpi-grid">
    <div class="kpi ca"><div class="kl">Sessions</div><div class="kv" id="k0">—</div><div class="ks">Conversations</div></div>
    <div class="kpi"><div class="kl">User Messages</div><div class="kv" id="k1">—</div><div class="ks">Prompts sent</div></div>
    <div class="kpi"><div class="kl">AI Responses</div><div class="kv" id="k2">—</div><div class="ks">AI turns</div></div>
    <div class="kpi cg"><div class="kl">Tool Calls</div><div class="kv" id="k3">—</div><div class="ks" id="k3s">unique tools</div></div>
    <div class="kpi cgo"><div class="kl">Output Volume</div><div class="kv" id="k4">—</div><div class="ks">chars generated</div></div>
    <div class="kpi cp"><div class="kl">Thinking Blocks</div><div class="kv" id="k5">—</div><div class="ks">Claude extended</div></div>
    <div class="kpi"><div class="kl">Active Days</div><div class="kv" id="k6">—</div><div class="ks">Days with usage</div></div>
    <div class="kpi"><div class="kl">Projects</div><div class="kv" id="k7">—</div><div class="ks">Unique dirs</div></div>
    <div class="kpi cb"><div class="kl">Input Tokens</div><div class="kv" id="k8">—</div><div class="ks" id="k8s">cache —%</div></div>
    <div class="kpi ct"><div class="kl">Output Tokens</div><div class="kv" id="k9">—</div><div class="ks">Claude only</div></div>
    <div class="kpi"><div class="kl">Avg Msg Length</div><div class="kv" id="k10">—</div><div class="ks">chars/prompt</div></div>
    <div class="kpi"><div class="kl">Memory Files</div><div class="kv">{total_mem}</div><div class="ks">Saved</div></div>
  </div>

  <div class="src-chips" id="chips"></div>

  <div class="tabs">
    <button class="tb active" onclick="showTab('ov',this)">Overview</button>
    <button class="tb" onclick="showTab('tl',this)">Tools &amp; Models</button>
    <button class="tb" onclick="showTab('cost',this)">Cost &amp; Cache</button>
    <button class="tb" onclick="showTab('pj',this)">Projects</button>
    <button class="tb" onclick="showTab('sv',this)">Sessions</button>
    <button class="tb" onclick="showTab('mv',this)">Memory</button>
    <button class="tb" onclick="showTab('st',this)">Settings &amp; Info</button>
  </div>

  <!-- OVERVIEW -->
  <div id="tab-ov" class="tp active">
    <div class="g1"><div class="card"><h3>Activity Timeline</h3><canvas id="ch-tl"></canvas></div></div>
    <div class="g2">
      <div class="card"><h3>Activity by Hour</h3><div class="hm" id="hm"></div></div>
      <div class="card"><h3>Day of Week</h3><canvas id="ch-wd"></canvas></div>
    </div>
    <div class="g2">
      <div class="card"><h3>Source Breakdown</h3><canvas id="ch-src"></canvas></div>
      <div class="card"><h3>Top Directories</h3>
        <div class="tw"><table class="dt"><thead><tr><th>Directory</th><th>Sessions</th></tr></thead>
        <tbody id="proj-body"></tbody></table></div>
      </div>
    </div>
  </div>

  <!-- TOOLS & MODELS -->
  <div id="tab-tl" class="tp">
    <div class="g2">
      <div class="card"><h3>Top Tools</h3><canvas id="ch-tools"></canvas></div>
      <div class="card"><h3>Models Used</h3><canvas id="ch-models"></canvas></div>
    </div>
    <div class="g2">
      <div class="card"><h3>Entrypoints</h3><canvas id="ch-ep"></canvas></div>
      <div class="card" style="display:flex;flex-direction:column;height:480px;overflow:hidden">
        <h3 style="flex-shrink:0">All Tools</h3>
        <div class="tw" style="flex:1;overflow-y:auto;min-height:0">
          <table class="dt"><thead><tr><th>Tool</th><th>Calls</th></tr></thead>
          <tbody id="tools-body"></tbody></table>
        </div>
      </div>
    </div>
  </div>

  <!-- COST & CACHE -->
  <div id="tab-cost" class="tp">
    <div class="kpi-grid">
      <div class="kpi cgo"><div class="kl">Est. Cost</div><div class="kv" id="c0">—</div><div class="ks">what you paid</div></div>
      <div class="kpi cg"><div class="kl">Cache Savings</div><div class="kv" id="c1">—</div><div class="ks" id="c1s">vs no cache</div></div>
      <div class="kpi cb"><div class="kl">Cost w/o Cache</div><div class="kv" id="c2">—</div><div class="ks">same volume, uncached</div></div>
      <div class="kpi ca"><div class="kl">Cache Hit Rate</div><div class="kv" id="c3">—</div><div class="ks" id="c3s">read share of input</div></div>
      <div class="kpi ct"><div class="kl">Cache Read</div><div class="kv" id="c4">—</div><div class="ks">tokens served</div></div>
      <div class="kpi cp"><div class="kl">Cache Write</div><div class="kv" id="c5">—</div><div class="ks">tokens written</div></div>
    </div>
    <div class="g2">
      <div class="card"><h3>Daily Cost (USD)</h3><canvas id="ch-dcost"></canvas></div>
      <div class="card"><h3>Cost by Model (USD)</h3><canvas id="ch-mcost"></canvas></div>
    </div>
    <div class="card">
      <h3>Cost by Model — first-party pricing</h3>
      <div class="tw"><table class="dt">
        <thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cache Write</th><th>Est. Cost</th></tr></thead>
        <tbody id="mcost-body"></tbody>
      </table></div>
      <p class="ks" style="margin-top:8px">Rates: first-party Anthropic API, USD per 1M tokens. Cache read = 0.1&times; input, cache write = 1.25&times; input (5-min TTL). Edit <code>RATES</code> in the generated HTML to adjust. Non-Claude tools are excluded (they log characters, not priced tokens).</p>
    </div>
  </div>

  <!-- PROJECTS -->
  <div id="tab-pj" class="tp">
    <div class="pj-layout">
      <div class="pj-left">
        <div class="card">
          <h3 style="flex-shrink:0">Project Activity</h3>
          <input id="pf" type="text" placeholder="Filter projects…" oninput="filterProj()" style="flex-shrink:0;width:100%;padding:6px 11px;border-radius:7px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:12px;margin-bottom:10px;outline:none">
          <div class="tw">
            <table class="dt">
              <thead><tr><th>Project</th><th>Msgs</th><th>Sess</th><th>Last Active</th></tr></thead>
              <tbody id="projects-body"></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="pj-right" id="pj-right">
        <div class="sess-detail-panel">
          <div class="sdh">
            <h4 id="sess-detail-title">Sessions</h4>
            <button onclick="closeSessDetail()">✕</button>
          </div>
          <div class="tw">
            <table class="dt">
              <thead><tr><th>Title</th><th>Msgs</th><th>In</th><th>Out</th><th>Cost</th><th>Started</th><th>Last Active</th></tr></thead>
              <tbody id="sess-detail-body"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- SESSIONS -->
  <div id="tab-sv" class="tp">
    <div class="card" style="display:flex;flex-direction:column;height:640px;overflow:hidden">
      <h3 style="flex-shrink:0">Sessions</h3>
      <input id="ss" type="text" placeholder="Filter by topic, model, tool, directory…" oninput="filterTbl()"
        style="flex-shrink:0;width:100%;padding:6px 11px;border-radius:7px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:12px;margin-bottom:8px;outline:none">
      <div class="tw" style="flex:1;overflow-y:auto;min-height:0">
        <table class="dt">
          <thead><tr><th>Source</th><th>Started</th><th>Topic / Title</th><th>U/AI</th>
            <th>Volume</th><th>Duration</th><th>Model</th><th>Directory</th></tr></thead>
          <tbody id="sess-body"></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- MEMORY -->
  <div id="tab-mv" class="tp">
    <div class="card"><h3>Memory Files</h3>{mem_html}</div>
  </div>

  <!-- SETTINGS -->
  <div id="tab-st" class="tp">
    <div class="g2">
      <div class="card"><h3>Settings Files</h3>{settings_html}</div>
      <div class="card"><h3>Scan Summary</h3>
        <table class="dt"><thead><tr><th>Source</th><th>Data</th><th>Path</th></tr></thead>
        <tbody>{scan_rows}</tbody></table>
      </div>
    </div>
  </div>

</div>

<script>
const ALL_EVENTS   = {ev_json};
const ALL_SESSIONS = {sess_json};
const SRC_COLORS   = {col_json};
const SRC_LABELS   = {lbl_json};
let curP='all', curS='all';

// ── Period bounds ──
function bounds(p){{
  const now=new Date();
  const to=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
  let from;
  if(p==='today') from=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  else if(p==='week'){{const d=(now.getDay()+6)%7;from=new Date(now.getFullYear(),now.getMonth(),now.getDate()-d);}}
  else if(p==='month') from=new Date(now.getFullYear(),now.getMonth(),1);
  else from=new Date(0);
  return{{from,to}};
}}

function filteredEvts(p,s){{
  const{{from,to}}=bounds(p);
  return ALL_EVENTS.filter(e=>{{
    if(s!=='all'&&e.source!==s)return false;
    if(!e.ts)return p==='all';
    const d=new Date(e.ts);return d>=from&&d<to;
  }});
}}
function filteredSess(evts,s){{
  const ids=new Set(evts.map(e=>e.sid));
  return ALL_SESSIONS.filter(x=>ids.has(x.id)&&(s==='all'||x.source===s));
}}

// ── Aggregation ──
function agg(evts,sess){{
  const tC={{}},mC={{}},eC={{}},pC={{}},hC={{}},dC={{}},wC={{}},sC={{}},costM={{}},dCost={{}};
  let uM=0,aM=0,tCl=0,tk=0,oV=0,iT=0,oT=0,cr=0,cw=0,tLen=0,lN=0,cost=0,costNC=0;
  const aD=new Set();
  for(const e of evts){{
    const d=e.ts?new Date(e.ts):null;
    const ds=d?d.toISOString().slice(0,10):null;
    const h=d?d.getHours():null,wd=d?(d.getDay()+6)%7:null;
    if(ds){{aD.add(ds);dC[ds]=(dC[ds]||0)+1;}}
    if(h!==null)hC[h]=(hC[h]||0)+1;
    if(wd!==null)wC[wd]=(wC[wd]||0)+1;
    sC[e.source]=(sC[e.source]||0)+1;
    if(e.t==='user'){{uM++;tLen+=(e.len||0);lN++;if(e.cwd)pC[e.cwd]=(pC[e.cwd]||0)+1;if(e.ep)eC[e.ep]=(eC[e.ep]||0)+1;}}
    if(e.t==='assistant'){{
      aM++;oV+=(e.out||0);iT+=(e.inp||0);
      oT+=(e.out&&e.source==='claude'?e.out:0);
      cr+=(e.cr||0);cw+=(e.cw||0);
      tk+=(e.thinking||0);
      if(e.model)mC[e.model]=(mC[e.model]||0)+1;
      for(const t of(e.tools||[])){{tC[t]=(tC[t]||0)+1;tCl++;}}
      // cost (priceable Claude models only — local/synthetic models are skipped)
      const r=rateFor(e.model);
      if(e.source==='claude'&&r){{
        const c=eventCost(e);
        const allIn=(e.inp||0)+(e.cr||0)+(e.cw||0);
        const nc=(allIn*r.input+(e.out||0)*r.output)/1e6;  // same volume, no caching
        cost+=c;costNC+=nc;
        if(ds)dCost[ds]=(dCost[ds]||0)+c;
        const m=e.model||'unknown';
        const cm=costM[m]||(costM[m]={{model:m,inp:0,out:0,cr:0,cw:0,cost:0}});
        cm.inp+=(e.inp||0);cm.out+=(e.out||0);cm.cr+=(e.cr||0);cm.cw+=(e.cw||0);cm.cost+=c;
      }}
    }}
  }}
  const top=(o,n=20)=>Object.entries(o).sort((a,b)=>b[1]-a[1]).slice(0,n);
  const allInput=iT+cr+cw;
  return{{uM,aM,tCl,tk,oV,iT,oT,cr,cw,
    cH:allInput?Math.round(100*cr/allInput):0,                 // cache read share of all input
    cost,costNC,saved:costNC-cost,
    costM:Object.values(costM).sort((a,b)=>b.cost-a.cost),
    dCost,
    tC,mC,eC,pC,hC,dC,wC,sC,
    aD:aD.size,avgL:lN?Math.round(tLen/lN):0,
    topT:top(tC),topM:top(mC,12),topE:top(eC,8),topP:top(pC,15),topS:top(sC),
    sN:sess.length,pN:Object.keys(pC).length}};
}}

// ── Charts ──
Chart.defaults.color='#8890b0';Chart.defaults.borderColor='#2e3250';
const CH={{}};
function dk(id){{if(CH[id]){{CH[id].destroy();delete CH[id];}}}}
const PAL=['#6c63ff','#1a73e8','#00c4b4','#10a37f','#f97316','#ff6584','#ffd700','#43e97b','#38f9d7','#f093fb','#a8edea','#fed6e3'];

// ── Pricing (first-party Anthropic API, USD per 1M tokens) ──
// cacheRead = 0.1x input · cacheWrite = 1.25x input (5-min TTL)
const RATES={{
  'claude-fable-5':   {{input:10,output:50,cr:1.00,cw:12.50}},
  'claude-opus-4-8':  {{input:5, output:25,cr:0.50,cw:6.25}},
  'claude-opus-4-7':  {{input:5, output:25,cr:0.50,cw:6.25}},
  'claude-opus-4-6':  {{input:5, output:25,cr:0.50,cw:6.25}},
  'claude-opus-4-5':  {{input:5, output:25,cr:0.50,cw:6.25}},
  'claude-opus-4-1':  {{input:15,output:75,cr:1.50,cw:18.75}},
  'claude-opus-4':    {{input:15,output:75,cr:1.50,cw:18.75}},
  'claude-opus-3':    {{input:15,output:75,cr:1.50,cw:18.75}},
  'claude-sonnet-4-6':{{input:3, output:15,cr:0.30,cw:3.75}},
  'claude-sonnet-4-5':{{input:3, output:15,cr:0.30,cw:3.75}},
  'claude-sonnet-4':  {{input:3, output:15,cr:0.30,cw:3.75}},
  'claude-haiku-4-5': {{input:1, output:5, cr:0.10,cw:1.25}},
  'claude-3-5-haiku': {{input:0.80,output:4,cr:0.08,cw:1.00}},
  'claude-3-haiku':   {{input:0.25,output:1.25,cr:0.03,cw:0.30}},
}};
const DEFAULT_RATE=RATES['claude-opus-4-8'];
function rateFor(model){{                                // null = not a priceable Claude model
  const id=String(model||'').replace(/^(anthropic|us|eu|apac)\\./,'');
  for(const k of Object.keys(RATES)) if(id.startsWith(k)) return RATES[k];
  return id.startsWith('claude-')?DEFAULT_RATE:null;     // unknown Claude → Opus; qwen/synthetic/etc → unpriced
}}
function eventCost(e){{
  if(e.source!=='claude')return 0;                      // others log chars, not priced tokens
  const r=rateFor(e.model); if(!r)return 0;
  return((e.inp||0)*r.input+(e.out||0)*r.output+(e.cr||0)*r.cr+(e.cw||0)*r.cw)/1e6;
}}

// ── Format ──
function fmt(n){{n=n||0;if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return String(Math.round(n));}}
function fmtD(s){{if(!s||s<0)return'—';if(s<60)return s.toFixed(0)+'s';if(s<3600)return Math.floor(s/60)+'m '+Math.floor(s%60)+'s';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';}}

// ── Render ──
function render(p,s){{
  const evts=filteredEvts(p,s);
  const sess=filteredSess(evts,s);
  const ag=agg(evts,sess);

  // Period label
  const{{from,to}}=bounds(p);
  const fd=d=>d.toLocaleDateString('en-GB',{{day:'numeric',month:'short',year:'numeric'}});
  const days=Object.keys(ag.dC).sort();
  document.getElementById('pr').textContent=
    p==='all'?(days.length?days[0]+' → '+days.slice(-1)[0]:''):fd(from)+' → '+fd(new Date(to-1));

  // KPIs
  ['k0','k1','k2','k3','k4','k5','k6','k7','k8','k9','k10'].forEach((id,i)=>{{
    const v=[ag.sN,ag.uM,ag.aM,ag.tCl,ag.oV,ag.tk,ag.aD,ag.pN,ag.iT,ag.oT,ag.avgL][i];
    document.getElementById(id).textContent=fmt(v);
  }});
  document.getElementById('k3s').textContent=Object.keys(ag.tC).length+' unique tools';
  document.getElementById('k8s').textContent='cache hit: '+ag.cH+'%';

  // Source chips
  document.getElementById('chips').innerHTML=ag.topS.map(([src,cnt])=>{{
    const c=SRC_COLORS[src]||'#888',l=SRC_LABELS[src]||src;
    return`<div class="chip" style="color:${{c}};border-color:${{c}};background:${{c}}22">
      <span>${{l}}</span><span style="font-weight:400">${{fmt(cnt)}} events</span></div>`;
  }}).join('');

  // Timeline
  const dl=Object.entries(ag.dC).sort((a,b)=>a[0]<b[0]?-1:1);
  dk('tl');
  if(dl.length)CH['tl']=new Chart(document.getElementById('ch-tl'),{{
    type:'line',
    data:{{labels:dl.map(d=>d[0]),datasets:[{{label:'Events',data:dl.map(d=>d[1]),
      borderColor:'#6c63ff',backgroundColor:'rgba(108,99,255,.15)',fill:true,tension:.4,pointRadius:2}}]}},
    options:{{responsive:true,plugins:{{legend:{{display:false}}}},
      scales:{{x:{{grid:{{color:'#2e3250'}},ticks:{{maxTicksLimit:14,font:{{size:10}}}}}},
               y:{{grid:{{color:'#2e3250'}},beginAtZero:true}}}}}}
  }});

  // Hourly heatmap
  const hm=document.getElementById('hm');hm.innerHTML='';
  const mxH=Math.max(...Array.from({{length:24}},(_,h)=>ag.hC[h]||0),1);
  for(let h=0;h<24;h++){{
    const v=ag.hC[h]||0,ix=v/mxH;
    const c=document.createElement('div');c.className='hmc';c.title=h+':00 — '+v;c.textContent=h;
    if(v>0){{c.style.background=`rgba(${{108+Math.round(ix*147)}},${{99-Math.round(ix*99)}},${{255-Math.round(ix*255)}},${{.35+ix*.65}})`;c.style.color=ix>.5?'#fff':'';}}
    hm.appendChild(c);
  }}

  // Weekday
  dk('wd');CH['wd']=new Chart(document.getElementById('ch-wd'),{{
    type:'bar',
    data:{{labels:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
      datasets:[{{label:'Events',data:[0,1,2,3,4,5,6].map(i=>ag.wC[i]||0),
        backgroundColor:['#6c63ff','#6c63ff','#6c63ff','#6c63ff','#6c63ff','#ff6584','#ff6584'].map(c=>c+'bb'),borderRadius:4}}]}},
    options:{{responsive:true,plugins:{{legend:{{display:false}}}},scales:{{x:{{grid:{{display:false}}}},y:{{grid:{{color:'#2e3250'}},beginAtZero:true}}}}}}
  }});

  // Source donut
  dk('src');
  if(ag.topS.length)CH['src']=new Chart(document.getElementById('ch-src'),{{
    type:'doughnut',
    data:{{labels:ag.topS.map(s=>SRC_LABELS[s[0]]||s[0]),
      datasets:[{{data:ag.topS.map(s=>s[1]),backgroundColor:ag.topS.map(s=>SRC_COLORS[s[0]]||'#888'),borderWidth:0}}]}},
    options:{{responsive:true,plugins:{{legend:{{position:'right',labels:{{font:{{size:11}}}}}}}}}}
  }});

  // Projects (overview card — top dirs)
  document.getElementById('proj-body').innerHTML=ag.topP.length
    ?ag.topP.map(([p,c])=>`<tr><td class="trunc" title="${{p}}">${{p.length>55?'…/'+p.split('/').slice(-2).join('/'):p}}</td><td>${{c}}</td></tr>`).join('')
    :'<tr><td colspan="2" class="nd">No directory data</td></tr>';

  // Projects tab — full table with click-to-expand sessions
  renderProjects(evts,sess);
  closeSessDetail();  // reset detail panel on each render

  // Tools
  dk('tools');
  if(ag.topT.length)CH['tools']=new Chart(document.getElementById('ch-tools'),{{
    type:'bar',
    data:{{labels:ag.topT.map(t=>t[0].replace('mcp__','')),
      datasets:[{{label:'Calls',data:ag.topT.map(t=>t[1]),backgroundColor:'rgba(67,233,123,.7)',borderRadius:3}}]}},
    options:{{indexAxis:'y',responsive:true,plugins:{{legend:{{display:false}}}},
      scales:{{x:{{grid:{{color:'#2e3250'}},beginAtZero:true}},y:{{grid:{{display:false}},ticks:{{font:{{size:10}}}}}}}}}}
  }});

  // Models
  dk('models');
  if(ag.topM.length)CH['models']=new Chart(document.getElementById('ch-models'),{{
    type:'doughnut',
    data:{{labels:ag.topM.map(m=>m[0]),
      datasets:[{{data:ag.topM.map(m=>m[1]),backgroundColor:PAL,borderWidth:0}}]}},
    options:{{responsive:true,plugins:{{legend:{{position:'right',labels:{{font:{{size:10}}}}}}}}}}
  }});

  // ── Cost & Cache ──
  document.getElementById('c0').textContent='$'+ag.cost.toFixed(2);
  document.getElementById('c1').textContent='$'+ag.saved.toFixed(2);
  document.getElementById('c1s').textContent=ag.costNC>0?Math.round(100*ag.saved/ag.costNC)+'% cheaper':'vs no cache';
  document.getElementById('c2').textContent='$'+ag.costNC.toFixed(2);
  document.getElementById('c3').textContent=ag.cH+'%';
  document.getElementById('c4').textContent=fmt(ag.cr);
  document.getElementById('c5').textContent=fmt(ag.cw);

  const dcl=Object.entries(ag.dCost).sort((a,b)=>a[0]<b[0]?-1:1);
  dk('dcost');
  if(dcl.length)CH['dcost']=new Chart(document.getElementById('ch-dcost'),{{
    type:'bar',
    data:{{labels:dcl.map(d=>d[0]),datasets:[{{label:'USD',data:dcl.map(d=>+d[1].toFixed(4)),
      backgroundColor:'rgba(255,215,0,.7)',borderRadius:3}}]}},
    options:{{responsive:true,plugins:{{legend:{{display:false}},
      tooltip:{{callbacks:{{label:c=>'$'+(+c.parsed.y).toFixed(2)}}}}}},
      scales:{{x:{{grid:{{color:'#2e3250'}},ticks:{{maxTicksLimit:14,font:{{size:10}}}}}},
               y:{{grid:{{color:'#2e3250'}},beginAtZero:true,ticks:{{callback:v=>'$'+v}}}}}}}}
  }});

  dk('mcost');
  if(ag.costM.length)CH['mcost']=new Chart(document.getElementById('ch-mcost'),{{
    type:'doughnut',
    data:{{labels:ag.costM.map(m=>m.model),
      datasets:[{{data:ag.costM.map(m=>+m.cost.toFixed(4)),backgroundColor:PAL,borderWidth:0}}]}},
    options:{{responsive:true,plugins:{{legend:{{position:'right',labels:{{font:{{size:10}}}}}},
      tooltip:{{callbacks:{{label:c=>c.label+': $'+(+c.parsed).toFixed(2)}}}}}}}}
  }});

  document.getElementById('mcost-body').innerHTML=ag.costM.length
    ?ag.costM.map(m=>`<tr><td class="trunc" title="${{m.model}}">${{m.model}}</td>
        <td>${{fmt(m.inp)}}</td><td>${{fmt(m.out)}}</td><td>${{fmt(m.cr)}}</td><td>${{fmt(m.cw)}}</td>
        <td style="color:var(--gold);font-weight:600">$${{m.cost.toFixed(2)}}</td></tr>`).join('')
       +`<tr style="border-top:2px solid var(--bd)"><td><b>Total</b></td><td></td><td></td><td></td><td></td>
         <td style="color:var(--gold);font-weight:700">$${{ag.cost.toFixed(2)}}</td></tr>`
    :'<tr><td colspan="6" class="nd">No Claude token usage in this period / source</td></tr>';

  // Entrypoints
  dk('ep');
  if(ag.topE.length)CH['ep']=new Chart(document.getElementById('ch-ep'),{{
    type:'pie',
    data:{{labels:ag.topE.map(e=>e[0]),
      datasets:[{{data:ag.topE.map(e=>e[1]),backgroundColor:PAL,borderWidth:0}}]}},
    options:{{responsive:true,plugins:{{legend:{{position:'right',labels:{{font:{{size:10}}}}}}}}}}
  }});

  // Tools table
  document.getElementById('tools-body').innerHTML=
    Object.entries(ag.tC).sort((a,b)=>b[1]-a[1]).map(([t,c])=>`<tr><td>${{t}}</td><td>${{c}}</td></tr>`).join('')
    ||'<tr><td colspan="2" class="nd">No tool calls</td></tr>';

  // Sessions table
  const sr=sess.filter(s=>s.start_ts).sort((a,b)=>b.start_ts.localeCompare(a.start_ts)).slice(0,400);
  document.getElementById('sess-body').innerHTML=sr.map(s=>{{
    const col=SRC_COLORS[s.source]||'#888',lbl=SRC_LABELS[s.source]||s.source||'?';
    const start=(s.start_ts||'').slice(0,16).replace('T',' ');
    const dur=s.start_ts&&s.end_ts?fmtD((new Date(s.end_ts)-new Date(s.start_ts))/1000):'—';
    const vol=fmt((s.input_tokens||0)+(s.output_tokens||0));
    const topic=((s.first_message||s.title||'—')).replace(/</g,'&lt;').slice(0,80);
    const cwd=s.cwd||'—',cwdS=cwd.length>45?'…/'+cwd.split('/').slice(-2).join('/'):cwd;
    const model=(s.models||[]).slice(0,2).join(', ')||'—';
    return`<tr>
      <td><span class="badge" style="background:${{col}}">${{lbl}}</span></td>
      <td style="white-space:nowrap;font-size:10px">${{start}}</td>
      <td class="trunc" title="${{topic}}">${{topic}}</td>
      <td>${{s.user_turns||0}}/${{s.assistant_turns||0}}</td>
      <td>${{vol}}</td><td>${{dur}}</td>
      <td style="font-size:10px" class="trunc">${{model}}</td>
      <td class="trunc" title="${{cwd}}">${{cwdS}}</td></tr>`;
  }}).join('')||'<tr><td colspan="8" class="nd">No sessions in this period / source</td></tr>';

  const q=document.getElementById('ss').value.toLowerCase();
  if(q)document.querySelectorAll('#sess-body tr').forEach(r=>{{r.style.display=r.textContent.toLowerCase().includes(q)?'':'none';}});
}}

// ── Controls ──
function setPeriod(p,btn){{
  curP=p;
  document.querySelectorAll('.pb').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  render(curP,curS);
}}
function setSrc(s,btn){{
  curS=s;
  document.querySelectorAll('.src-btn').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  render(curP,curS);
}}
function showTab(n,btn){{
  document.querySelectorAll('.tp').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tb').forEach(b=>b.classList.remove('active'));
  document.getElementById('tab-'+n).classList.add('active');
  if(btn)btn.classList.add('active');
}}
function filterTbl(){{
  const q=document.getElementById('ss').value.toLowerCase();
  document.querySelectorAll('#sess-body tr').forEach(r=>{{r.style.display=r.textContent.toLowerCase().includes(q)?'':'none';}});
}}

// ── Project Activity ──
function fmtDate(ts){{
  if(!ts)return'—';
  const d=new Date(ts);
  return d.toLocaleString('en-GB',{{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}});
}}
function fmtTok(n){{if(!n)return'—';return n>=1000?(n/1000).toFixed(1)+'K':String(n);}}
function sessCost(s){{
  if(s.source!=='claude')return null;
  const m=(s.models&&s.models[0])||'';
  const r=rateFor(m);
  if(!r)return null;
  const c=(((s.input_tokens||0)*r.input+(s.output_tokens||0)*r.output+(s.cache_read||0)*r.cr+(s.cache_create||0)*r.cw)/1e6);
  return c;
}}
function renderProjects(evts,sess){{
  // group sessions by cwd
  const byProj={{}};
  for(const s of sess){{
    const cwd=s.cwd||'(unknown)';
    if(!byProj[cwd])byProj[cwd]={{cwd,msgs:0,sessions:0,last:''}};
    byProj[cwd].sessions++;
    byProj[cwd].msgs+=(s.user_turns||0)+(s.assistant_turns||0);
    const ts=s.end_ts||s.start_ts||'';
    if(ts>byProj[cwd].last)byProj[cwd].last=ts;
  }}
  const rows=Object.values(byProj).sort((a,b)=>b.last.localeCompare(a.last));
  const name=p=>p.split('/').filter(Boolean).pop()||p;
  document.getElementById('projects-body').innerHTML=rows.map((p,i)=>
    `<tr class="proj-row" data-cwd="${{escHtml(p.cwd)}}" onclick="loadProjectSessions(this,'${{escHtml(p.cwd)}}')">
      <td title="${{escHtml(p.cwd)}}"><span class="project-badge">${{escHtml(name(p.cwd))}}</span></td>
      <td>${{p.msgs}}</td>
      <td>${{p.sessions}}</td>
      <td style="white-space:nowrap">${{fmtDate(p.last)}}</td>
    </tr>`
  ).join('')||'<tr><td colspan="4" class="nd">No projects in this period</td></tr>';
}}
function escHtml(s){{return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');}}
function loadProjectSessions(rowEl,cwd){{
  // toggle active row
  document.querySelectorAll('.proj-row').forEach(r=>r.classList.remove('active-row'));
  rowEl.classList.add('active-row');
  // get current filtered sessions for this cwd
  const evts=filteredEvts(curP,curS);
  const sess=filteredSess(evts,curS).filter(s=>s.cwd===cwd);
  const sorted=sess.sort((a,b)=>(b.start_ts||'').localeCompare(a.start_ts||''));
  const name=cwd.split('/').filter(Boolean).pop()||cwd;
  document.getElementById('sess-detail-title').textContent='Sessions — '+name;
  document.getElementById('sess-detail-body').innerHTML=sorted.map(s=>{{
    const title=((s.first_message||s.title||'—')).replace(/</g,'&lt;').slice(0,80);
    const cost=sessCost(s);
    const costStr=cost!=null?'$'+cost.toFixed(2):'—';
    const msgs=(s.user_turns||0)+(s.assistant_turns||0);
    return`<tr>
      <td class="prompt-text" title="${{escHtml(s.first_message||s.title||'')}}">${{title}}</td>
      <td>${{msgs}}</td>
      <td>${{fmtTok(s.input_tokens)}}</td>
      <td>${{fmtTok(s.output_tokens)}}</td>
      <td>${{costStr}}</td>
      <td style="white-space:nowrap">${{fmtDate(s.start_ts)}}</td>
      <td style="white-space:nowrap">${{fmtDate(s.end_ts)}}</td>
    </tr>`;
  }}).join('')||'<tr><td colspan="7" class="nd">No sessions found</td></tr>';
  document.getElementById('pj-right').classList.add('open');
}}
function closeSessDetail(){{
  document.getElementById('pj-right').classList.remove('open');
  document.querySelectorAll('.proj-row').forEach(r=>r.classList.remove('active-row'));
}}
function filterProj(){{
  const q=document.getElementById('pf').value.toLowerCase();
  document.querySelectorAll('#projects-body tr').forEach(r=>{{
    r.style.display=r.textContent.toLowerCase().includes(q)?'':'none';
  }});
}}

render('all','all');
</script>
</body>
</html>"""


# ─────────────────────────────────────────────────────────────────────────────
#  MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main():
    pa = argparse.ArgumentParser(
        description="Unified AI Tools Analyzer — Claude · Gemini · Antigravity · ChatGPT · Codex · Puku CLI")
    pa.add_argument("--path",    nargs="*", help="Extra root paths to scan")
    pa.add_argument("--chatgpt", nargs="*", metavar="FILE",
                    help="Path(s) to ChatGPT conversations.json")
    pa.add_argument("--output","-o", default="ai_tools_report.html")
    pa.add_argument("--no-claude",      action="store_true")
    pa.add_argument("--no-gemini",      action="store_true")
    pa.add_argument("--no-antigravity", action="store_true")
    pa.add_argument("--no-codex",       action="store_true")
    pa.add_argument("--no-puku",        action="store_true")
    pa.add_argument("--verbose","-v",   action="store_true")
    args = pa.parse_args()

    print("=" * 64)
    print("  AI Tools Unified Analyzer")
    print("=" * 64)

    home = Path.home()
    all_events:   list[dict] = []
    all_sessions: list[dict] = []
    scan_info = {"sources": {}}

    # ── Claude ────────────────────────────────────────────────────────────
    if not args.no_claude:
        claude_roots = []
        # Desktop (Cowork + Claude Code IDE sessions)
        desktop = home / ".config" / "Claude"
        for sub in ("claude-code-sessions", "local-agent-mode-sessions"):
            p = desktop / sub
            if p.is_dir():
                claude_roots.append(p)
        if not claude_roots and desktop.is_dir():
            claude_roots.append(desktop)   # fallback: scan whole folder
        # CLI
        cli = home / ".claude" / "projects"
        if cli.is_dir():
            claude_roots.append(cli)
        elif (home / ".claude").is_dir():
            claude_roots.append(home / ".claude")
        # user-supplied paths
        for p in (args.path or []):
            pp = Path(p)
            if pp.is_dir():
                claude_roots.append(pp)

        if claude_roots:
            print(f"\n🟣 Claude: scanning {len(claude_roots)} folder(s)…")
            if args.verbose:
                for r in claude_roots: print(f"    {r}")
            evts, sess = parse_claude(claude_roots)
            all_events   += evts
            all_sessions += sess
            paths_str = " | ".join(str(r) for r in claude_roots)
            print(f"    {len(sess):,} sessions · {len(evts):,} events")
            scan_info["sources"]["claude"] = {
                "events": len(evts), "sessions": len(sess), "path": paths_str}
        else:
            print("\n🟣 Claude: no folders found")

    # ── Gemini CLI ────────────────────────────────────────────────────────
    if not args.no_gemini:
        gemini_root = home / ".gemini"
        if gemini_root.is_dir():
            print(f"\n🔵 Gemini CLI: scanning {gemini_root} …")
            evts, sess = parse_gemini(gemini_root)
            all_events   += evts
            all_sessions += sess
            print(f"    {len(sess):,} sessions · {len(evts):,} events")
            scan_info["sources"]["gemini"] = {
                "events": len(evts), "sessions": len(sess), "path": str(gemini_root/"tmp/*/chats")}
        else:
            print("\n🔵 Gemini CLI: ~/.gemini/ not found")

    # ── Antigravity ───────────────────────────────────────────────────────
    if not args.no_antigravity:
        gemini_root = home / ".gemini"
        ag_dirs = [
            gemini_root / "antigravity-ide" / "brain",
            gemini_root / "antigravity-cli" / "brain",
        ]
        if any(d.is_dir() for d in ag_dirs):
            print(f"\n🩵 Antigravity: scanning IDE + CLI transcripts…")
            evts, sess = parse_antigravity(gemini_root)
            all_events   += evts
            all_sessions += sess
            print(f"    {len(sess):,} sessions · {len(evts):,} events")
            scan_info["sources"]["antigravity"] = {
                "events": len(evts), "sessions": len(sess),
                "path": str(gemini_root / "antigravity-{ide,cli}/brain")}
        else:
            print("\n🩵 Antigravity: no folders found in ~/.gemini/")

    # ── ChatGPT ───────────────────────────────────────────────────────────
    chatgpt_paths = [Path(f) for f in (args.chatgpt or [])]
    # auto-scan Downloads/Desktop/Documents
    for base in [home/"Downloads", home/"Desktop", home/"Documents"]:
        for f in [base/"conversations.json"] + list(base.glob("*/conversations.json")):
            if f.exists() and f not in chatgpt_paths:
                chatgpt_paths.append(f)
    if chatgpt_paths:
        print(f"\n🟢 ChatGPT: {len(chatgpt_paths)} file(s)…")
        evts, sess = parse_chatgpt(chatgpt_paths)
        all_events   += evts
        all_sessions += sess
        print(f"    {len(sess):,} sessions · {len(evts):,} events")
        scan_info["sources"]["chatgpt"] = {
            "events": len(evts), "sessions": len(sess),
            "path": " | ".join(str(f) for f in chatgpt_paths)}
    else:
        print("\n🟢 ChatGPT: no conversations.json found")
        print("   Export at chat.openai.com → Settings → Data Controls → Export data")
        print("   Then: python3 claude_analyzer.py --chatgpt ~/Downloads/conversations.json")

    # ── Codex ─────────────────────────────────────────────────────────────
    if not args.no_codex:
        codex_root = home / ".codex"
        if codex_root.is_dir():
            print(f"\n🟠 Codex CLI: scanning {codex_root} …")
            evts, sess = parse_codex(codex_root)
            all_events   += evts
            all_sessions += sess
            print(f"    {len(sess):,} sessions · {len(evts):,} events")
            scan_info["sources"]["codex"] = {
                "events": len(evts), "sessions": len(sess),
                "path": str(codex_root/"sessions")}
        else:
            print("\n🟠 Codex CLI: ~/.codex/ not found")

    # ── Puku CLI ──────────────────────────────────────────────────────────
    if not args.no_puku:
        puku_root = home / ".puku-cli" / "projects"
        if puku_root.is_dir():
            print(f"\n🩷 Puku CLI: scanning {puku_root} …")
            evts, sess = parse_puku(puku_root)
            all_events   += evts
            all_sessions += sess
            print(f"    {len(sess):,} sessions · {len(evts):,} events")
            scan_info["sources"]["puku"] = {
                "events": len(evts), "sessions": len(sess),
                "path": str(puku_root)}
        else:
            print("\n🩷 Puku CLI: ~/.puku-cli/projects/ not found")

    if not all_events:
        print("\n⚠  No events found from any source.")
        sys.exit(1)

    u = sum(1 for e in all_events if e["t"]=="user")
    a = sum(1 for e in all_events if e["t"]=="assistant")
    print(f"\n📊 Total: {len(all_sessions):,} sessions · {u:,} user + {a:,} AI messages")

    # ── Memory & settings ─────────────────────────────────────────────────
    claude_roots_all = []
    for sub in ("claude-code-sessions","local-agent-mode-sessions","projects"):
        for base in [home/".config"/"Claude", home/".claude"]:
            p = base / sub
            if p.is_dir(): claude_roots_all.append(p)
    if not claude_roots_all:
        for base in [home/".config"/"Claude", home/".claude"]:
            if base.is_dir(): claude_roots_all.append(base)
    # Also look for Codex memories
    codex_mem = home / ".codex" / "memories"
    if codex_mem.is_dir(): claude_roots_all.append(codex_mem)

    mem_files     = find_memory_files(claude_roots_all)
    memory_data   = analyze_memory(mem_files)
    settings_data = analyze_settings(claude_roots_all)

    print("\n🏗  Building dashboard…")
    html = build_html(
        all_events=all_events,
        all_sessions=all_sessions,
        memory_data=memory_data,
        settings_data=settings_data,
        scan_info=scan_info,
        generated_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    )

    out = Path(args.output)
    out.write_text(html, encoding="utf-8")
    print(f"\n✅  Dashboard → {out.resolve()}")
    print(f"    Size: {len(html)//1024} KB")
    print("    Filters: Today / This Week / This Month / All Time")
    print("    Sources: All / Claude / Gemini / Antigravity / ChatGPT / Codex / Puku CLI")
    print("=" * 64)


if __name__ == "__main__":
    main()
