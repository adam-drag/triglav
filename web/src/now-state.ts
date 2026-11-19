/** No transcript entry for this long, while the agent is not in a wait: it may be stuck. */
export const QUIET_MS = 10 * 60_000;

/** An agent's newest action, as `AgentNow` in src/agent-stream.ts sends it. */
export interface Now {
  at: string;
  doing?: { text: string; since: string; running: boolean };
  recent?: { text: string; at: string }[];
}

/** "45s", "6m", "2h 5m": how long ago `ts` was, short enough for a map node. */
export function span(ts: string, now: number) {
  const sec = Math.max(0, Math.floor((now - new Date(ts).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
}

/** How an agent's newest action reads on the live map: busy, waiting, or quiet for too long. */
export function nowState(n: Now, now: number): 'busy' | 'waiting' | 'quiet' {
  // Only a wait still in progress: once it returned, the agent should be doing something again.
  if (n.doing?.running && /^Waiting/.test(n.doing.text)) return 'waiting';
  return now - new Date(n.at).getTime() > QUIET_MS ? 'quiet' : 'busy';
}

/** The status line of an agent node. A finished action is not shown as the current one: the agent writes its next step. */
export function nowLabel(n: Now, now: number) {
  if (nowState(n, now) === 'quiet') return `Quiet for ${span(n.at, now)}`;
  return n.doing?.running ? `${n.doing.text} · ${span(n.doing.since, now)}` : `Writing · ${span(n.at, now)}`;
}

/** The actions before the current one, newest first: a finished action leads the list, so the card still shows it. */
export function recentOf(n: Now | undefined) {
  if (!n) return [];
  return [...(n.doing && !n.doing.running ? [{ text: n.doing.text, at: n.doing.since }] : []), ...(n.recent ?? [])];
}
