#!/usr/bin/env bash
# Claude Code Stop hook: keeps an orchestrator agent from ending its turn while it still owns work.
# Sessions that never registered with the orchestrator, ended sessions, and paused jobs stop normally.
# If the orchestrator cannot be reached, the hook lets the session stop rather than trap it.
set -u
input="$(cat)"
transcript="$(jq -r '.transcript_path // empty' <<<"$input")"
[ -n "$transcript" ] && [ -f "$transcript" ] || exit 0
# Only a token this session itself passed to an orchestrator tool. A token that merely appears in
# command output (another agent's, printed while debugging) must not trap this session.
token="$(jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and (.name|startswith("mcp__orchestrator__"))) | .input.session_token // empty' "$transcript" 2>/dev/null | tail -1)"
[ -n "$token" ] || exit 0
url="${ORCH_URL:-http://127.0.0.1:7400}"
open="$(jq -n --arg t "$token" '{session_token: $t}' | curl -sf -m 5 -X POST "$url/api/hooks/stop" -H 'content-type: application/json' -d @- | jq -r '.open_work // empty')" || exit 0
[ -n "$open" ] || exit 0
jq -n --arg o "$open" '{decision: "block", reason: ("Do not end your turn: " + $o + " Post any status for the Client as an inform message on the job thread, then keep calling wait_for_events (max_wait_sec 240). You may stop only after end_session, or when the job is done, cancelled or paused.")}'
