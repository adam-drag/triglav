/**
 * Runs the production `mergeFindings` over the findings of a stored run, so a change to the merge can be checked against
 * stored seat output without a live run. The findings are exactly what `parseReviewerOutput` returned, with the seat name.
 */
import { clusterFindings, DEFAULT_PANEL, mergeFindings, type MergedFinding, type SeatFinding } from '../../src/code-review.ts';
import type { Judgments, Run } from './data.ts';

/**
 * Whether a stored seat is a shadow seat. A stored run has no shadow flag: the harness runs the default panel's seats (`pickSeats`),
 * so the flag is the default panel's for that seat name, as a review with the default panel would set it.
 */
const shadowSeat = (seat: string): boolean => !!DEFAULT_PANEL.find((p) => p.seat === seat)?.shadow;

export function seatFindings(run: Run): SeatFinding[] {
  return run.seats.filter((s) => !s.error).flatMap((s) => s.findings.map((f): SeatFinding => ({ ...f, seat: s.seat, shadow: shadowSeat(s.seat) })));
}

export function mergeRun(run: Run): { raw: number; merged: MergedFinding[] } {
  const all = seatFindings(run);
  return { raw: all.length, merged: mergeFindings(all) };
}

/**
 * The duplicates the reader judged in a run (`dup_of`) and how many of them the production clustering still keeps in two
 * clusters. Membership is by the finding itself (seat and index), not by its text or sites.
 */
export function duplicatesAfterMerge(run: Run, judgments: Judgments): { total: number; left: number } {
  const byKey = new Map<string, SeatFinding>();
  for (const s of run.seats) if (!s.error) s.findings.forEach((f, i) => byKey.set(`${s.seat}#${i}`, { ...f, seat: s.seat, shadow: shadowSeat(s.seat) }));
  const clusters = clusterFindings([...byKey.values()]);
  let total = 0;
  let left = 0;
  for (const j of judgments.fixtures[run.fixture] ?? []) {
    if (!j.dup_of) continue;
    const a = byKey.get(j.dup_of);
    const b = byKey.get(`${j.seat}#${j.index}`);
    if (!a || !b) continue;
    total += 1;
    if (!clusters.some((c) => c.includes(a) && c.includes(b))) left += 1;
  }
  return { total, left };
}
