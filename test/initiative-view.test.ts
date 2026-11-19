import { describe, expect, it } from 'vitest';
import { ageText, citedLine, commandOf, mergedCheckOf, mergedGatesOf, quotableIn, stepParts } from '../web/src/initiative-view.ts';

describe('the your-step command', () => {
  it('is the first code span of the step', () => {
    expect(commandOf('Run `npm test` then stop')).toBe('npm test');
    expect(commandOf('Run `a` and `b`')).toBe('a');
  });

  it('is none for a step without a code span, an unclosed span, an empty span or a span over 300 characters', () => {
    expect(commandOf('Check the page')).toBeNull();
    expect(commandOf('Run `npm test')).toBeNull();
    expect(commandOf('Run `` now')).toBeNull();
    expect(commandOf(`Run \`${'x'.repeat(301)}\` then \`npm test\``)).toBeNull();
  });

  it('is none for a span with a line break', () => {
    expect(commandOf('Run `npm\ntest`')).toBeNull();
  });

  it('takes exactly 300 characters', () => {
    expect(commandOf(`Run \`${'x'.repeat(300)}\``)).toBe('x'.repeat(300));
  });
});

describe('the quotable selection', () => {
  it('is a plain phrase the stored field holds', () => {
    expect(quotableIn('Adam decided this in a meeting.', 'decided this')).toBe(true);
  });

  it('is refused when the rendered text differs from the stored markup', () => {
    expect(quotableIn('**Adam** decided', 'Adam decided')).toBe(false);
    expect(quotableIn('[a link](https://example.com) here', 'a link here')).toBe(false);
    expect(quotableIn('first\n\nsecond', 'first\nsecond')).toBe(false);
  });

  it('is refused for a missing field or an empty selection', () => {
    expect(quotableIn(undefined, 'x')).toBe(false);
    expect(quotableIn('abc', '')).toBe(false);
  });
});

describe('the merged check of a card', () => {
  const evidence = { url: 'https://github.com/adam-drag/triglav/pull/77', merged_at: '2026-11-18T10:00:00.000Z' };

  it('is the PR and merge time of a met gate that a check marked, with the card it waits for', () => {
    expect(mergedCheckOf([{ key: 'merged:a', met: true, met_by: 'check', evidence }])).toEqual({ source: 'a', url: evidence.url, merged_at: evidence.merged_at });
  });

  it('is none for a gate the Client marked by hand, even when an earlier check left evidence', () => {
    expect(mergedCheckOf([{ key: 'merged:a', met: true, met_by: 'client', evidence }])).toBeNull();
  });

  it('is none for an open gate, a gate that is not merged, or a gate with no merge time', () => {
    expect(mergedCheckOf([{ key: 'merged:a', met: false, met_by: null, evidence }])).toBeNull();
    expect(mergedCheckOf([{ key: 'decision:D1', met: true, met_by: 'check', evidence }])).toBeNull();
    expect(mergedCheckOf([{ key: 'merged:a', met: true, met_by: 'check', evidence: { url: evidence.url } }])).toBeNull();
  });

  it('keeps only a github.com link', () => {
    const m = mergedCheckOf([{ key: 'merged:a', met: true, met_by: 'check', evidence: { ...evidence, url: 'javascript:alert(1)' } }]);
    expect(m?.url).toBeNull();
  });
});

describe('the age of a check', () => {
  const now = Date.parse('2026-11-19T12:00:00.000Z');
  it('reads in minutes, hours and days', () => {
    expect(ageText('2026-11-19T11:55:00.000Z', now)).toBe('5 min ago');
    expect(ageText('2026-11-19T09:00:00.000Z', now)).toBe('3 h ago');
    expect(ageText('2026-11-16T12:00:00.000Z', now)).toBe('3 days ago');
  });

  it('says so when the time is not recorded', () => {
    expect(ageText(null, now)).toBe('time not recorded');
  });
});

describe('the rendered step', () => {
  it('shows the text without backticks and offers the first command', () => {
    expect(stepParts('Run `npm test` now')).toEqual({ text: 'Run npm test now', command: 'npm test' });
  });

  it('offers no command for a step without one', () => {
    expect(stepParts('Check the page')).toEqual({ text: 'Check the page', command: null });
  });
});

describe('the cited line', () => {
  it('names the file, the line, the commit (12 characters), the repository and the age of the check', () => {
    const now = Date.parse('2026-11-19T12:00:00.000Z');
    expect(citedLine({ repo: 'calctree/frontend', path: 'src/a.ts', line: 12, sha: '0123456789abcdef0123' }, '2026-11-19T11:55:00.000Z', now)).toBe(
      'Checked: src/a.ts:12 at 0123456789ab (calctree/frontend), verified 5 min ago',
    );
  });
});

describe('the merged checks of the cards', () => {
  const evidence = { url: 'https://github.com/adam-drag/triglav/pull/77', merged_at: '2026-11-18T10:00:00.000Z' };

  it('keys a check by the card that waits for it, and names the card whose merge it is', () => {
    const map = mergedGatesOf([{ key: 'b', gates: [{ key: 'merged:a', met: true, met_by: 'check', evidence }] }]);
    expect(Object.keys(map)).toEqual(['b']);
    expect(map.b).toEqual({ source: 'a', url: evidence.url, merged_at: evidence.merged_at });
  });

  it('leaves out a card whose merged gate the Client marked, and a card with no key', () => {
    const map = mergedGatesOf([
      { key: 'c', gates: [{ key: 'merged:a', met: true, met_by: 'client', evidence }] },
      { gates: [{ key: 'merged:a', met: true, met_by: 'check', evidence }] },
    ]);
    expect(map).toEqual({});
  });
});
