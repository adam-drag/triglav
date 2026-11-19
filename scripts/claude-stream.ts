/**
 * Reading the output of `claude -p --output-format stream-json --verbose`: the plan windows of a `rate_limit_event` (the
 * Operator, the Architect and research runs) and the usage of the final `result` (research runs). Pure, so the tests read
 * it without a process. Everything here is model or CLI output, so every number is checked before it is kept.
 */

/** One plan window as Claude reports it: the share used in percent, and when it resets (epoch seconds). */
export interface PlanWindow {
  window: string;
  used: number;
  resets_at: number | null;
}

/**
 * The plan windows of a `rate_limit_event`. Claude reports how much of each window is used as a fraction (0.22 is 22%).
 * That scale is an assumption: it was 0.22 and 0.33 in the one run that was compared, which fits the usage of that session,
 * and a value above 1 is taken as a percent.
 */
export function planWindows(msg: any): PlanWindow[] {
  if (msg?.type !== 'rate_limit_event') return [];
  return Object.entries(msg.rate_limit_info?.unifiedWindows ?? {}).flatMap(([window, w]: [string, any]) =>
    typeof w?.utilization === 'number' && Number.isFinite(w.utilization) && w.utilization >= 0
      ? [{ window, used: w.utilization <= 1 ? w.utilization * 100 : w.utilization, resets_at: typeof w.resetsAt === 'number' ? w.resetsAt : null }]
      : [],
  );
}

/** What one run used, from its final `result`. `cost_usd` is Claude Code's API-price figure, not the share of a plan window. */
export interface RunUsage {
  tokens_in: number | null;
  tokens_cache_write: number | null;
  tokens_cached: number | null;
  tokens_out: number | null;
  turns: number | null;
  cost_usd: number | null;
}

const count = (v: unknown, max = 1e12): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null);

export function runUsage(msg: any): RunUsage | null {
  if (msg?.type !== 'result') return null;
  const u = msg.usage && typeof msg.usage === 'object' ? msg.usage : {};
  const cost = msg.total_cost_usd;
  return {
    tokens_in: count(u.input_tokens),
    tokens_cache_write: count(u.cache_creation_input_tokens),
    tokens_cached: count(u.cache_read_input_tokens),
    tokens_out: count(u.output_tokens),
    turns: count(msg.num_turns, 1e6),
    cost_usd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && cost <= 1e6 ? cost : null,
  };
}

/** The most characters of the run's final text that go into the exit tail. */
export const RESULT_TEXT_MAX = 1500;

/**
 * Reads a run's stream one line at a time and keeps the newest plan windows (with the time they were read, so an old
 * reading never replaces a newer one from elsewhere), the final usage and the final text. Other lines are ignored.
 */
export function streamReader() {
  let windows: PlanWindow[] = [];
  let windowsAt: number | null = null;
  let usage: RunUsage | null = null;
  let text = '';
  return {
    feed(line: string, now = Date.now()) {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const w = planWindows(msg);
      if (w.length) {
        windows = w;
        windowsAt = now;
      }
      const u = runUsage(msg);
      if (u) {
        usage = u;
        if (typeof msg.result === 'string') text = msg.result.slice(-RESULT_TEXT_MAX);
      }
    },
    /** The typed fields of the exit report. */
    report(): { windows: PlanWindow[]; windows_at: number | null; usage: RunUsage | null } {
      return { windows, windows_at: windowsAt, usage };
    },
    /** The run's final text, for the exit tail only. */
    resultText(): string {
      return text;
    },
  };
}
