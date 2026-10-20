#!/usr/bin/env bash
# Claude Code Stop and SubagentStop hook: keeps an orchestrator agent from ending its turn while it still owns work.
# Sessions that never registered with the orchestrator, ended sessions, and paused jobs stop normally.
# If the orchestrator cannot be reached, the hook lets the session stop rather than trap it.
# Seniors run as subagents, and Claude Code fires SubagentStop for them, not Stop. In a SubagentStop
# event transcript_path is the parent's (Staff's) transcript, so the token comes only from
# agent_transcript_path; without it the hook lets the subagent stop (a Staff token must never trap a Senior).
set -u
input="$(cat)"
if [ "$(jq -r '.hook_event_name // empty' <<<"$input")" = "SubagentStop" ]; then
  transcript="$(jq -r '.agent_transcript_path // empty' <<<"$input")"
else
  transcript="$(jq -r '.transcript_path // empty' <<<"$input")"
fi
[ -n "$transcript" ] && [ -f "$transcript" ] || exit 0
# Only a token this session itself passed to an orchestrator tool. A token that merely appears in
# command output (another agent's, printed while debugging) must not trap this session.
token="$(jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and (.name|startswith("mcp__orchestrator__"))) | .input.session_token // empty' "$transcript" 2>/dev/null | tail -1)"
[ -n "$token" ] || exit 0
url="${ORCH_URL-http://127.0.0.1:7400}"
# The session token goes to this URL, so it must be plain http to this machine: no other host, no credentials, no redirect.
[[ "$url" =~ ^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?/?$ ]] || exit 0
open="$(jq -n --arg t "$token" '{session_token: $t}' | curl -q -sf -m 5 --noproxy '*' --proto =http --max-redirs 0 -X POST "${url%/}/api/hooks/stop" -H 'content-type: application/json' -d @- | jq -r '.open_work // empty')" || exit 0
[ -n "$open" ] || exit 0
jq -n --arg o "$open" '{decision: "block", reason: ("Do not end your turn: " + $o + " Post any status for the Client as an inform message on the job thread, then keep calling wait_for_events (leave max_wait_sec out). You may stop only after end_session, or when the job is done, cancelled or paused.")}'
