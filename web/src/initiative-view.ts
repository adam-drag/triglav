/**
 * Pure rules of the initiative room (phase 5), kept out of the React file so the unit tests can read them.
 */

/** The prepared command of a step: its first code span, when it is 1 to 300 characters on one line. Otherwise none. */
export function commandOf(step: string): string | null {
  const open = step.indexOf('`');
  if (open < 0) return null;
  const close = step.indexOf('`', open + 1);
  if (close < 0) return null;
  const command = step.slice(open + 1, close);
  return command.length >= 1 && command.length <= 300 && !command.includes('\n') ? command : null;
}

/**
 * Whether a selected text can be quoted. The selection is the rendered text, so it is quoted only when the stored field
 * holds it as it is: text with bold, links, lists or a line break is not in the source, and the server would refuse it.
 */
export function quotableIn(stored: unknown, selected: string): boolean {
  return typeof stored === 'string' && selected.length > 0 && stored.includes(selected);
}

export type MergedCheck = { source: string; url: string | null; merged_at: string };

/**
 * The merged checks of a card: for each met merged gate that a check marked (not the Client), the PR and merge time that
 * the check stored, with the card whose merge the gate waits for. A gate the Client marked by hand is not a check, so its
 * evidence (an earlier check's, if any) is not used. A card can have several merged gates, so the list can have several.
 */
export function mergedChecksOf(gates: { key?: unknown; met?: unknown; met_by?: unknown; evidence?: unknown }[]): MergedCheck[] {
  const out: MergedCheck[] = [];
  for (const g of gates) {
    if (!g.met || g.met_by !== 'check' || typeof g.key !== 'string' || !g.key.startsWith('merged:')) continue;
    const evidence = g.evidence as { url?: unknown; merged_at?: unknown } | null | undefined;
    if (typeof evidence?.merged_at !== 'string') continue;
    const url = typeof evidence.url === 'string' && /^https:\/\/github\.com\//.test(evidence.url) ? evidence.url : null;
    out.push({ source: g.key.slice('merged:'.length), url, merged_at: evidence.merged_at });
  }
  return out;
}

/** How long ago a check was recorded, for a citation: "12 min ago", "3 h ago" or "2 days ago". */
export function ageText(ts: string | null | undefined, now: number = Date.now()): string {
  if (!ts) return 'time not recorded';
  const mins = Math.max(0, Math.round((now - new Date(ts).getTime()) / 60_000));
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

/** A step's text, and its prepared command when it has one (a Copy button). The backticks are not shown. */
export function stepParts(step: string): { text: string; command: string | null } {
  return { text: step.replace(/`/g, ''), command: commandOf(step) };
}

/** The line that says where a code citation was checked: the path and line, the commit (12 characters) and the age. */
export function citedLine(code: { repo?: unknown; path?: unknown; line?: unknown; sha?: unknown }, checkedAt: string | null | undefined, now?: number): string {
  return `Checked: ${String(code.path)}:${String(code.line)} at ${String(code.sha).slice(0, 12)} (${String(code.repo)}), verified ${ageText(checkedAt, now)}`;
}

/**
 * The merged checks of each card that has one, keyed by the card that waits for the merge (the card with the merged gate).
 * Each check names the card whose merge it is. Only current cards.
 */
export function mergedGatesOf(cards: { key?: unknown; gates?: unknown }[]): Record<string, MergedCheck[]> {
  const out: Record<string, MergedCheck[]> = {};
  for (const c of cards) {
    if (typeof c.key !== 'string') continue;
    const checks = mergedChecksOf((Array.isArray(c.gates) ? c.gates : []) as { key?: unknown; met?: unknown; met_by?: unknown; evidence?: unknown }[]);
    if (checks.length > 0) out[c.key] = checks;
  }
  return out;
}

/**
 * The merged checks of each card whose own job merged, keyed by that card (the source). Staff's rule (message 5562 on the
 * General thread of the job): the PR and merge date show on the card whose merge it is, read from the gate evidence that
 * names it. The card that waits for the merge keeps its own line (mergedGatesOf). One line per PR and time.
 */
export function mergedSourcesOf(cards: { key?: unknown; gates?: unknown }[]): Record<string, MergedCheck[]> {
  const out: Record<string, MergedCheck[]> = {};
  for (const c of cards) {
    const checks = mergedChecksOf((Array.isArray(c.gates) ? c.gates : []) as { key?: unknown; met?: unknown; met_by?: unknown; evidence?: unknown }[]);
    for (const m of checks) {
      if (!out[m.source]) out[m.source] = [];
      if (!out[m.source].some((x) => x.url === m.url && x.merged_at === m.merged_at)) out[m.source].push(m);
    }
  }
  return out;
}
