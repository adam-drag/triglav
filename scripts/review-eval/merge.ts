/**
 * Runs the production `mergeFindings` over the findings of a stored run, so a change to the merge can be checked against
 * stored seat output without a live run. The findings are exactly what `parseReviewerOutput` returned, with the seat name.
 */
import { mergeFindings, type MergedFinding, type SeatFinding } from '../../src/code-review.ts';
import type { Run } from './data.ts';

export function seatFindings(run: Run): SeatFinding[] {
  return run.seats.filter((s) => !s.error).flatMap((s) => s.findings.map((f): SeatFinding => ({ ...f, seat: s.seat })));
}

export function mergeRun(run: Run): { raw: number; merged: MergedFinding[] } {
  const all = seatFindings(run);
  return { raw: all.length, merged: mergeFindings(all) };
}
