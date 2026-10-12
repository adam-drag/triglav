#!/usr/bin/env bash
# Claude Code status line that also reports the plan usage to Triglav (Usage page, "Plan limits").
# Claude Code passes rate_limits.five_hour / seven_day (used_percentage, resets_at) to the status line on stdin.
# Set it in ~/.claude/settings.json: "statusLine": {"type": "command", "command": "/path/to/claude-statusline.sh"}
# The report runs in the background with a 2 second limit, so the status line never waits for Triglav.
input="$(cat)"
limits="$(jq -c '{five_hour: .rate_limits.five_hour, seven_day: .rate_limits.seven_day} | with_entries(select(.value != null))' <<<"$input" 2>/dev/null)"
url="${ORCH_URL-http://127.0.0.1:7400}"
# Plan usage goes to this URL only when it is plain http to this machine: no other host, no credentials, no redirect.
if [ -n "$limits" ] && [ "$limits" != "{}" ] && [[ "$url" =~ ^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?/?$ ]]; then
  (curl -q -sf -m 2 --noproxy '*' --proto =http --max-redirs 0 -X POST "${url%/}/api/usage/claude" -H 'content-type: application/json' -d "$limits" >/dev/null 2>&1 &)
fi
dir="$(jq -r '.workspace.current_dir // .cwd // empty' <<<"$input" 2>/dev/null)"
printf '\033[01;32m[%s@%s\033[01;37m %s\033[01;32m]\033[00m ' "$(whoami)" "$(hostname -s)" "$(basename "${dir:-$PWD}")"
