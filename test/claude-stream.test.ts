import { describe, expect, it } from 'vitest';
import { planWindows, RESULT_TEXT_MAX, runUsage, streamReader } from '../scripts/claude-stream.ts';

// The shapes below are cut from a real `claude -p --output-format stream-json --verbose` run (Claude Code 2.1.304, 2026-11-19).
const RATE_LIMIT = {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed', resetsAt: 1795054800, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.56, resetsAt: 1795054800 }, seven_day: { utilization: 0.73, resetsAt: 1795150800 } } },
};
const RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 3,
  total_cost_usd: 0.0123,
  result: 'ok',
  usage: { input_tokens: 9, cache_creation_input_tokens: 31000, cache_read_input_tokens: 120000, output_tokens: 800, server_tool_use: {}, service_tier: 'standard' },
};

describe('plan windows from a rate_limit_event', () => {
  it('reads each window as a percent with its reset time', () => {
    expect(planWindows(RATE_LIMIT)).toEqual([
      { window: 'five_hour', used: 0.56 * 100, resets_at: 1795054800 },
      { window: 'seven_day', used: 73, resets_at: 1795150800 },
    ]);
  });

  it('takes a value above 1 as a percent and drops values that are not numbers or are negative', () => {
    const msg = { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 42 }, seven_day: { utilization: 'x' }, other: { utilization: -0.1 } } } };
    expect(planWindows(msg)).toEqual([{ window: 'five_hour', used: 42, resets_at: null }]);
    expect(planWindows({ type: 'result' })).toEqual([]);
  });
});

describe('the usage of a run from its result', () => {
  it('keeps the four token counts, the turns and the API-price cost', () => {
    expect(runUsage(RESULT)).toEqual({ tokens_in: 9, tokens_cache_write: 31000, tokens_cached: 120000, tokens_out: 800, turns: 3, cost_usd: 0.0123 });
  });

  it('turns a missing or bad number into null instead of guessing', () => {
    expect(runUsage({ type: 'result', usage: { input_tokens: -3, output_tokens: 1.5 }, total_cost_usd: 'free', num_turns: null })).toEqual({
      tokens_in: null, tokens_cache_write: null, tokens_cached: null, tokens_out: null, turns: null, cost_usd: null,
    });
    expect(runUsage(RATE_LIMIT)).toBeNull();
  });
});

describe('reading a run stream line by line', () => {
  it('keeps the newest windows with the time it read them, the final usage and the final text, and ignores lines that are not JSON', () => {
    const r = streamReader();
    const lines = ['{"type":"system","subtype":"init"}', JSON.stringify(RATE_LIMIT), 'not json', '', JSON.stringify({ ...RATE_LIMIT, rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.6 } } } }), JSON.stringify(RESULT)];
    lines.forEach((line, i) => r.feed(line, 1000 + i));
    expect(r.report()).toEqual({ windows: [{ window: 'five_hour', used: 60, resets_at: null }], windows_at: 1004, usage: runUsage(RESULT) });
    expect(r.resultText()).toBe('ok');
  });

  it('reports no usage and no text for a run that was stopped before its result', () => {
    const r = streamReader();
    r.feed(JSON.stringify(RATE_LIMIT), 5);
    expect(r.report()).toMatchObject({ windows_at: 5, usage: null });
    expect(r.resultText()).toBe('');
  });

  it('keeps only the end of a long final text', () => {
    const r = streamReader();
    r.feed(JSON.stringify({ ...RESULT, result: `${'a'.repeat(RESULT_TEXT_MAX)}end` }));
    expect(r.resultText()).toHaveLength(RESULT_TEXT_MAX);
    expect(r.resultText().endsWith('end')).toBe(true);
  });
});
