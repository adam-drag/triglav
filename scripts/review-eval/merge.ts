/**
 * Runs the production `mergeFindings` over the findings of a stored run, so a change to the merge can be checked against
 * stored seat output without a live run. The findings are exactly what `parseReviewerOutput` returned, with the seat name.
 */
import { mergeFindings, type MergedFinding, type SeatFinding } from '../../src/code-review.ts';
import type { Judgments, Run } from './data.ts';

export function seatFindings(run: Run): SeatFinding[] {
  return run.seats.filter((s) => !s.error).flatMap((s) => s.findings.map((f): SeatFinding => ({ ...f, seat: s.seat })));
}

export function mergeRun(run: Run): { raw: number; merged: MergedFinding[] } {
  const all = seatFindings(run);
  return { raw: all.length, merged: mergeFindings(all) };
}

/**
 * The duplicates the reader judged in a run (`dup_of`) and how many of them the production merge still keeps as two
 * findings. A pair counts as merged when one merged finding names both seats and holds the sites of both.
 */
export function duplicatesAfterMerge(run: Run, judgments: Judgments): { total: number; left: number } {
  const seat = (name: string) => run.seats.find((x) => x.seat === name);
  const { merged } = mergeRun(run);
  let total = 0;
  let left = 0;
  for (const j of judgments.fixtures[run.fixture] ?? []) {
    if (!j.dup_of) continue;
    const [firstSeat, firstIndex] = j.dup_of.split('#') as [string, string];
    const a = seat(firstSeat)?.findings[Number(firstIndex)];
    const b = seat(j.seat)?.findings[j.index];
    if (!a || !b) continue;
    total += 1;
    const holds = (m: { sites: { file: string; line: number }[] }, f: { sites: { file: string; line: number }[] }) => f.sites.every((s) => m.sites.some((t) => t.file === s.file && t.line === s.line));
    const together = merged.some((m) => m.reviewers.includes(firstSeat) && m.reviewers.includes(j.seat) && holds(m, a) && holds(m, b));
    if (!together) left += 1;
  }
  return { total, left };
}
