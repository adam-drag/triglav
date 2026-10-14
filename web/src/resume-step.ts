type Launch = { requested_at: string; picked_at?: string | null; finished_at?: string | null; result?: string | null };

/** How long a started session gets to reconnect before the card says it is stuck. A healthy Staff calls Triglav within a minute or so. */
export const RECONNECT_GRACE_MS = 2 * 60_000;

export type ResumeStep = 'sent' | 'queued' | 'starting' | 'reconnecting' | 'stuck' | 'failed' | 'skipped' | null;

/** Where a resume is, from the Client's click to the agent being back. The runner reports a skipped one as "ok: skipped: ...". */
export function resumeStep(live: Launch | null, sentAt: number | null, now: number): ResumeStep {
  // A click newer than the last launch (a first resume, or a restart of a stuck one) is the latest word until the server lists its launch.
  if (sentAt && (!live || sentAt > new Date(live.requested_at).getTime())) return 'sent';
  if (!live) return null;
  if (!live.picked_at) return 'queued';
  if (!live.finished_at) return 'starting';
  const result = String(live.result ?? '');
  if (result.startsWith('failed')) return 'failed';
  if (now - new Date(live.finished_at).getTime() > RECONNECT_GRACE_MS) return 'stuck';
  return /^(ok: )?skipped/.test(result) ? 'skipped' : 'reconnecting';
}
