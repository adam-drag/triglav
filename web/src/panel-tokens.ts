/** Averages of the finished seat runs of one runtime, model and effort (from `/api/review-panel`). */
export type SeatAverage = { runtime: string; model: string; effort: string; runs: number; tokens_in: number; tokens_out: number };
type Seat = { runtime: string; model: string; effort: string };
type Panel = { strong: Seat & { count?: number }; cheap: Seat[] };

export type ExpectedTokens = {
  /** Seats the panel would start, strong members included. */
  seats: number;
  /** Seats with no finished run of their model yet: they add nothing to the sums. */
  unknown: number;
  tokens_in: number;
  tokens_out: number;
};

/**
 * The input and output tokens one review of this panel is expected to use: for each seat, the average of the finished runs of
 * the same runtime, model and effort, else of the same runtime and model (any effort), else nothing. A repeated strong seat counts once
 * per member. This is an average of past runs, not a limit.
 */
export function expectedTokens(panel: Panel, averages: SeatAverage[]): ExpectedTokens {
  const average = (s: Seat): { tokens_in: number; tokens_out: number } | null => {
    const exact = averages.find((a) => a.runtime === s.runtime && a.model === s.model && a.effort === s.effort);
    if (exact) return exact;
    const sameModel = averages.filter((a) => a.runtime === s.runtime && a.model === s.model);
    const runs = sameModel.reduce((n, a) => n + a.runs, 0);
    if (!runs) return null;
    return { tokens_in: sameModel.reduce((n, a) => n + a.tokens_in * a.runs, 0) / runs, tokens_out: sameModel.reduce((n, a) => n + a.tokens_out * a.runs, 0) / runs };
  };
  const seats: Seat[] = [...Array.from({ length: panel.strong.count ?? 1 }, () => panel.strong), ...panel.cheap];
  const out: ExpectedTokens = { seats: seats.length, unknown: 0, tokens_in: 0, tokens_out: 0 };
  for (const s of seats) {
    const a = average(s);
    if (!a) out.unknown++;
    else {
      out.tokens_in += a.tokens_in;
      out.tokens_out += a.tokens_out;
    }
  }
  out.tokens_in = Math.round(out.tokens_in);
  out.tokens_out = Math.round(out.tokens_out);
  return out;
}
