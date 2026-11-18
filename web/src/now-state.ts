/** No transcript entry for this long, while the agent is not in a wait: it may be stuck. */
export const QUIET_MS = 10 * 60_000;

/** How an agent's newest action (`AgentNow` in src/agent-stream.ts) reads on the live map: busy, waiting, or quiet for too long. */
export function nowState(n: { at: string; doing?: { text: string; running: boolean } }, now: number): 'busy' | 'waiting' | 'quiet' {
  // Only a wait still in progress: once it returned, the agent should be doing something again.
  if (n.doing?.running && /^Waiting/.test(n.doing.text)) return 'waiting';
  return now - new Date(n.at).getTime() > QUIET_MS ? 'quiet' : 'busy';
}
