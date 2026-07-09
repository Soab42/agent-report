#!/usr/bin/env python3
"""
MyAgent — Build your own Claude-powered agent from scratch.
No Claude Code required. Just the Anthropic API + Python.

Features:
  • Multi-turn conversation with full context
  • Prompt caching (10× cheaper on system prompt + tools)
  • Tool execution: bash, read_file, write_file, web_search
  • JSONL session logs → compatible with ai_tools_report.html dashboard
  • Token & cost tracking per session
  • Works exactly like Claude Code / Cowork internally

Setup:
  pip install anthropic
  export ANTHROPIC_API_KEY=sk-ant-...
  python3 myagent.py

Usage:
  python3 myagent.py                        # interactive chat
  python3 myagent.py --task "list all py files in ~/projects"
  python3 myagent.py --model claude-sonnet-4-6
  python3 myagent.py --no-tools             # plain chat, no tool execution
  python3 myagent.py --show-cost            # print cost after each turn
"""

import anthropic
import argparse
import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# ─────────────────────────────────────────────────────────────────
#  CONFIG  — change these to customise your agent
# ─────────────────────────────────────────────────────────────────

DEFAULT_MODEL  = "claude-opus-4-8"   # or claude-sonnet-4-6, claude-haiku-4-5-20251001
MAX_TOKENS     = 8192
LOG_DIR        = Path.home() / ".myagent" / "projects"

SYSTEM_PROMPT  = """You are a highly capable AI assistant and software engineer.
You have access to tools that let you run bash commands, read/write files, and search the web.
Be concise. Always use tools when they help — don't just describe what you'd do, do it.
When running bash commands, prefer short targeted commands over long pipelines.
Current working directory: """ + str(Path.cwd())


# ─────────────────────────────────────────────────────────────────
#  TOOL DEFINITIONS
#  These get cached — sent once, reused every turn for free.
# ─────────────────────────────────────────────────────────────────

TOOLS = [
    {
        "name": "bash",
        "description": (
            "Run a bash shell command and return its stdout + stderr. "
            "Use this to run scripts, list files, check system state, install packages, etc."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The bash command to execute"
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout in seconds (default 30)",
                    "default": 30
                }
            },
            "required": ["command"]
        }
    },
    {
        "name": "read_file",
        "description": "Read the contents of a file from disk.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute or relative file path to read"
                },
                "offset": {
                    "type": "integer",
                    "description": "Line number to start reading from (0-indexed)",
                    "default": 0
                },
                "limit": {
                    "type": "integer",
                    "description": "Max number of lines to return",
                    "default": 200
                }
            },
            "required": ["path"]
        }
    },
    {
        "name": "write_file",
        "description": "Write or overwrite a file on disk.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File path to write"
                },
                "content": {
                    "type": "string",
                    "description": "Content to write to the file"
                }
            },
            "required": ["path", "content"]
        }
    },
    {
        "name": "list_dir",
        "description": "List files and directories at a given path.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory path to list",
                    "default": "."
                },
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern to filter (e.g. '*.py')",
                    "default": "*"
                }
            },
            "required": []
        }
    },
]


# ─────────────────────────────────────────────────────────────────
#  TOOL EXECUTOR
# ─────────────────────────────────────────────────────────────────

def execute_tool(name: str, inputs: dict) -> str:
    """Execute a tool and return its output as a string."""

    try:
        if name == "bash":
            timeout = inputs.get("timeout", 30)
            result  = subprocess.run(
                inputs["command"],
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=Path.cwd()
            )
            output = ""
            if result.stdout: output += result.stdout
            if result.stderr: output += result.stderr
            if result.returncode != 0:
                output += f"\n[Exit code: {result.returncode}]"
            return output.strip() or "(no output)"

        elif name == "read_file":
            p       = Path(inputs["path"]).expanduser()
            offset  = inputs.get("offset", 0)
            limit   = inputs.get("limit", 200)
            lines   = p.read_text(errors="replace").splitlines()
            chunk   = lines[offset : offset + limit]
            total   = len(lines)
            header  = f"[{p} — lines {offset+1}–{offset+len(chunk)} of {total}]\n"
            return header + "\n".join(f"{offset+i+1:4d}  {l}" for i, l in enumerate(chunk))

        elif name == "write_file":
            p = Path(inputs["path"]).expanduser()
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(inputs["content"])
            return f"Written {len(inputs['content'])} chars to {p}"

        elif name == "list_dir":
            p       = Path(inputs.get("path", ".")).expanduser()
            pattern = inputs.get("pattern", "*")
            items   = sorted(p.glob(pattern))
            lines   = []
            for item in items[:100]:
                kind = "DIR " if item.is_dir() else "FILE"
                size = f"{item.stat().st_size:>10,}" if item.is_file() else "          "
                lines.append(f"{kind}  {size}  {item.name}")
            return "\n".join(lines) or "(empty directory)"

        else:
            return f"Unknown tool: {name}"

    except subprocess.TimeoutExpired:
        return f"[Tool timed out after {inputs.get('timeout', 30)}s]"
    except Exception as e:
        return f"[Tool error: {type(e).__name__}: {e}]"


# ─────────────────────────────────────────────────────────────────
#  JSONL SESSION LOGGER
#  Writes logs compatible with ai_tools_report.html dashboard
# ─────────────────────────────────────────────────────────────────

class SessionLogger:
    def __init__(self, session_id: str):
        self.session_id = session_id
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        self.path = LOG_DIR / f"{session_id}.jsonl"

        # Cumulative token counters
        self.total_input    = 0
        self.total_output   = 0
        self.total_cr       = 0   # cache read
        self.total_cw       = 0   # cache write

    def _write(self, record: dict):
        record.setdefault("sessionId",  self.session_id)
        record.setdefault("timestamp",  datetime.now(timezone.utc).isoformat())
        record.setdefault("entrypoint", "myagent")
        record.setdefault("cwd",        str(Path.cwd()))
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

    def log_user(self, text: str):
        self._write({
            "type":    "user",
            "message": {"role": "user", "content": text}
        })

    def log_tool_results(self, results: list):
        self._write({
            "type":          "user",
            "message":       {"role": "user", "content": results},
            "toolUseResult": True
        })

    def log_assistant(self, response) -> dict:
        """Log assistant response, return usage dict."""
        usage = response.usage
        inp   = getattr(usage, "input_tokens",               0)
        out   = getattr(usage, "output_tokens",              0)
        cr    = getattr(usage, "cache_read_input_tokens",    0)
        cw    = getattr(usage, "cache_creation_input_tokens",0)

        self.total_input  += inp
        self.total_output += out
        self.total_cr     += cr
        self.total_cw     += cw

        content_serialised = []
        for block in response.content:
            if hasattr(block, "model_dump"):
                content_serialised.append(block.model_dump())
            elif hasattr(block, "__dict__"):
                content_serialised.append(block.__dict__)
            else:
                content_serialised.append(str(block))

        self._write({
            "type": "assistant",
            "message": {
                "role":    "assistant",
                "model":   response.model,
                "content": content_serialised,
                "usage": {
                    "input_tokens":                inp,
                    "output_tokens":               out,
                    "cache_read_input_tokens":     cr,
                    "cache_creation_input_tokens": cw,
                }
            }
        })
        return {"inp": inp, "out": out, "cr": cr, "cw": cw}

    def log_last_prompt(self, text: str):
        self._write({
            "type":       "last-prompt",
            "lastPrompt": text,
            "leafUuid":   str(uuid.uuid4()),
        })

    def summary(self) -> str:
        total = self.total_input + self.total_output
        cr_pct = (100 * self.total_cr / max(self.total_input, 1))
        return (f"Tokens: {total:,} total  "
                f"({self.total_input:,} in / {self.total_output:,} out)  "
                f"Cache hit: {cr_pct:.0f}%")


# ─────────────────────────────────────────────────────────────────
#  COST ESTIMATOR  (Anthropic pricing as of 2025)
# ─────────────────────────────────────────────────────────────────

# Price per million tokens in USD
PRICING = {
    "claude-opus-4-8":            {"input": 15.0, "output": 75.0, "cache_read": 1.50, "cache_write": 18.75},
    "claude-sonnet-4-6":          {"input":  3.0, "output": 15.0, "cache_read": 0.30, "cache_write":  3.75},
    "claude-haiku-4-5-20251001":  {"input":  0.8, "output":  4.0, "cache_read": 0.08, "cache_write":  1.00},
    "claude-fable-5":             {"input":  3.0, "output": 15.0, "cache_read": 0.30, "cache_write":  3.75},
}

def estimate_cost(model: str, usage: dict) -> tuple[float, float]:
    """Returns (actual_cost, cost_without_cache) in USD."""
    p = PRICING.get(model, PRICING["claude-sonnet-4-6"])
    M = 1_000_000
    actual = (
        usage["inp"] * p["input"] / M +
        usage["out"] * p["output"] / M +
        usage["cr"]  * p["cache_read"] / M +
        usage["cw"]  * p["cache_write"] / M
    )
    # What it would cost with no cache (all tokens at input price)
    no_cache = (
        (usage["inp"] + usage["cr"] + usage["cw"]) * p["input"] / M +
        usage["out"] * p["output"] / M
    )
    return actual, no_cache


# ─────────────────────────────────────────────────────────────────
#  AGENT CORE
# ─────────────────────────────────────────────────────────────────

class Agent:
    def __init__(self, model: str, use_tools: bool, show_cost: bool):
        self.model      = model
        self.use_tools  = use_tools
        self.show_cost  = show_cost
        self.client     = anthropic.Anthropic()
        self.session_id = str(uuid.uuid4())
        self.logger     = SessionLogger(self.session_id)
        self.history: list[dict] = []          # full conversation messages[]
        self.turn_count = 0

    def _system(self) -> list[dict]:
        """System prompt with cache_control — cached once, reused every turn."""
        return [
            {
                "type": "text",
                "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"}  # KEY: marks this for caching
            }
        ]

    def _tools_with_cache(self) -> list[dict]:
        """Tool list with cache mark on the last tool — Anthropic caches up to that point."""
        if not self.use_tools:
            return []
        tools = [t.copy() for t in TOOLS]
        # Mark the last tool for caching (everything before it is also cached)
        tools[-1]["cache_control"] = {"type": "ephemeral"}
        return tools

    def _call_api(self) -> object:
        """Single API call with full conversation history."""
        kwargs = dict(
            model=self.model,
            max_tokens=MAX_TOKENS,
            system=self._system(),
            messages=self.history,
        )
        if self.use_tools:
            kwargs["tools"] = self._tools_with_cache()

        return self.client.messages.create(**kwargs)

    def send(self, user_text: str) -> str:
        """Send a user message. Handles multi-step tool use internally. Returns final text."""
        self.turn_count += 1
        self.logger.log_user(user_text)
        self.history.append({"role": "user", "content": user_text})

        final_text = ""
        session_usage = {"inp": 0, "out": 0, "cr": 0, "cw": 0}

        # ── Inner loop: keep calling API until no more tool calls ──
        while True:
            response = self._call_api()
            usage    = self.logger.log_assistant(response)

            for k in session_usage:
                session_usage[k] += usage[k]

            # Extract text and tool calls from response
            text_parts  = []
            tool_calls  = []

            for block in response.content:
                btype = getattr(block, "type", "")
                if btype == "text":
                    text_parts.append(block.text)
                elif btype == "tool_use":
                    tool_calls.append(block)

            if text_parts:
                final_text = "\n".join(text_parts)

            # Add assistant turn to history
            self.history.append({
                "role":    "assistant",
                "content": response.content
            })

            # Execute tool calls if any
            if tool_calls and self.use_tools:
                tool_results = []
                for tc in tool_calls:
                    _print_tool(tc.name, tc.input)
                    result = execute_tool(tc.name, tc.input)
                    _print_tool_result(result)
                    tool_results.append({
                        "type":        "tool_result",
                        "tool_use_id": tc.id,
                        "content":     result
                    })

                # Add tool results to history and loop back
                self.logger.log_tool_results(tool_results)
                self.history.append({
                    "role":    "user",
                    "content": tool_results
                })
                # Continue loop to let Claude process tool results
            else:
                # No tool calls → conversation turn complete
                break

        self.logger.log_last_prompt(user_text)

        # Cost display
        if self.show_cost and sum(session_usage.values()) > 0:
            actual, no_cache = estimate_cost(self.model, session_usage)
            saved = no_cache - actual
            cr_pct = 100 * session_usage["cr"] / max(session_usage["inp"] + session_usage["cr"], 1)
            print(f"\n  💰 Turn cost: ${actual:.4f}  "
                  f"(saved ${saved:.4f} via {cr_pct:.0f}% cache hit)")

        return final_text


# ─────────────────────────────────────────────────────────────────
#  PRETTY PRINT HELPERS
# ─────────────────────────────────────────────────────────────────

RESET = "\033[0m"
BOLD  = "\033[1m"
DIM   = "\033[2m"
CYAN  = "\033[36m"
GREEN = "\033[32m"
YELLOW= "\033[33m"
PURPLE= "\033[35m"

def _print_tool(name: str, inputs: dict):
    args = json.dumps(inputs, ensure_ascii=False)
    if len(args) > 120:
        args = args[:120] + "…"
    print(f"{DIM}  ⚙ {CYAN}{name}{RESET}{DIM}({args}){RESET}")

def _print_tool_result(result: str):
    preview = result.replace("\n", " ")[:160]
    if len(result) > 160:
        preview += f"… ({len(result)} chars total)"
    print(f"{DIM}  → {preview}{RESET}")


# ─────────────────────────────────────────────────────────────────
#  CLI  ENTRY POINT
# ─────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="MyAgent — Claude-powered agent from scratch"
    )
    parser.add_argument("--model","-m",  default=DEFAULT_MODEL,
        help=f"Model to use (default: {DEFAULT_MODEL})")
    parser.add_argument("--task","-t",   default=None,
        help="Run a single task non-interactively, then exit")
    parser.add_argument("--no-tools",    action="store_true",
        help="Disable tool execution (plain conversation)")
    parser.add_argument("--show-cost",   action="store_true",
        help="Show estimated cost after each turn")
    parser.add_argument("--log-dir",     default=str(LOG_DIR),
        help=f"Directory to write session JSONL logs (default: {LOG_DIR})")
    args = parser.parse_args()

    # Override log dir if user specified one
    global LOG_DIR
    LOG_DIR = Path(args.log_dir)

    # Check API key
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("❌  ANTHROPIC_API_KEY not set.")
        print("    Get a key at: https://console.anthropic.com/")
        print("    Then: export ANTHROPIC_API_KEY=sk-ant-...")
        sys.exit(1)

    agent = Agent(
        model      = args.model,
        use_tools  = not args.no_tools,
        show_cost  = args.show_cost,
    )

    # ── Single task mode ──
    if args.task:
        print(f"{BOLD}{PURPLE}MyAgent{RESET}  [{agent.model}]  session: {agent.session_id[:8]}\n")
        response = agent.send(args.task)
        print(f"{GREEN}{BOLD}Assistant:{RESET} {response}")
        print(f"\n{DIM}{agent.logger.summary()}{RESET}")
        print(f"{DIM}Log: {agent.logger.path}{RESET}")
        return

    # ── Interactive mode ──
    print(f"{BOLD}{PURPLE}MyAgent{RESET}  model={agent.model}  "
          f"tools={'on' if agent.use_tools else 'off'}  "
          f"session={agent.session_id[:8]}")
    print(f"{DIM}Logs → {LOG_DIR}   |   Type 'exit' to quit   |   Ctrl+C to abort{RESET}\n")

    while True:
        try:
            user_input = input(f"{BOLD}You:{RESET} ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not user_input:
            continue
        if user_input.lower() in ("exit", "quit", "q", ":q"):
            break

        # Special commands
        if user_input == "/cost":
            print(agent.logger.summary())
            continue
        if user_input == "/clear":
            agent.history = []
            print(f"{DIM}Context cleared.{RESET}")
            continue
        if user_input == "/log":
            print(f"{DIM}{agent.logger.path}{RESET}")
            continue
        if user_input == "/help":
            print(f"{DIM}/cost · /clear · /log · /help · exit{RESET}")
            continue

        try:
            response = agent.send(user_input)
            print(f"\n{GREEN}{BOLD}Assistant:{RESET} {response}\n")
        except anthropic.APIError as e:
            print(f"  {YELLOW}API error: {e}{RESET}")
        except KeyboardInterrupt:
            print(f"\n{DIM}(interrupted){RESET}\n")
            agent.history = agent.history[:-1]   # remove partial user turn

    # Session summary
    print(f"\n{DIM}─────────────────────────────{RESET}")
    print(f"{DIM}Session ended.  {agent.logger.summary()}{RESET}")
    print(f"{DIM}Log saved: {agent.logger.path}{RESET}")
    print(f"{DIM}Analyze it: python3 claude_analyzer.py --path {LOG_DIR}{RESET}")


if __name__ == "__main__":
    main()
