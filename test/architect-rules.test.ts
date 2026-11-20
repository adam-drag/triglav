import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARCHITECT_RULES, RULES_MARKER, rulesWake, withRules } from '../src/architect-rules.ts';
import { loadGuide } from '../src/mcp.ts';

// The Architect's exceptions are written once, in src/architect-rules.ts. These tests pin that the card, the served guide
// and the wake all read them from there.

const card = readFileSync(join(import.meta.dirname, '..', 'src', 'guide', 'architect.md'), 'utf8');

describe('Architect rules', () => {
  it('the card has the marker once, and withRules puts every rule there', () => {
    expect(card.split(RULES_MARKER)).toHaveLength(2);
    const filled = withRules(card);
    expect(filled).not.toContain(RULES_MARKER);
    for (const r of ARCHITECT_RULES) expect(filled).toContain(`**${r.title}.** ${r.guide}`);
    // The rules sit under the exceptions heading, before the blockers paragraph.
    expect(filled.indexOf('**Your exceptions.**')).toBeLessThan(filled.indexOf(`**${ARCHITECT_RULES[0].title}.**`));
    expect(filled.indexOf(`**${ARCHITECT_RULES[ARCHITECT_RULES.length - 1].title}.**`)).toBeLessThan(filled.indexOf('**Blockers.**'));
  });

  it('a card without the marker gets the rules at the end', () => {
    expect(withRules('## Architect\ncard')).toBe(`## Architect\ncard\n\n${ARCHITECT_RULES.map((r) => `**${r.title}.** ${r.guide}`).join('\n\n')}`);
  });

  it('the served architect guide shows the rules, not the marker', () => {
    const guide = loadGuide('http://localhost', 'architect');
    expect(guide).not.toContain(RULES_MARKER);
    for (const r of ARCHITECT_RULES) expect(guide).toContain(`**${r.title}.**`);
  });

  it('ids and tool names are unique, and the wake names every rule tool', () => {
    expect(new Set(ARCHITECT_RULES.map((r) => r.id)).size).toBe(ARCHITECT_RULES.length);
    expect(new Set(ARCHITECT_RULES.map((r) => r.tool.name)).size).toBe(ARCHITECT_RULES.length);
    for (const r of ARCHITECT_RULES) expect(rulesWake()).toContain(r.tool.name);
  });
});
