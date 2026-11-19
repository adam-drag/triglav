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

/**
 * The merged check a card shows: the PR and merge time that a check stored for a met merged gate of the card. A gate the
 * Client marked by hand is not a check, so its evidence (an earlier check's, if any) is not used. `source` is the card
 * whose merge the gate waits for.
 */
export function mergedCheckOf(gates: { key?: unknown; met?: unknown; met_by?: unknown; evidence?: unknown }[]): { source: string; url: string | null; merged_at: string } | null {
  for (const g of gates) {
    if (!g.met || g.met_by !== 'check' || typeof g.key !== 'string' || !g.key.startsWith('merged:')) continue;
    const evidence = g.evidence as { url?: unknown; merged_at?: unknown } | null | undefined;
    if (typeof evidence?.merged_at !== 'string') continue;
    const url = typeof evidence.url === 'string' && /^https:\/\/github\.com\//.test(evidence.url) ? evidence.url : null;
    return { source: g.key.slice('merged:'.length), url, merged_at: evidence.merged_at };
  }
  return null;
}

/** How long ago a check was recorded, for a citation: "12 min ago", "3 h ago" or "2 days ago". */
export function ageText(ts: string | null | undefined, now: number = Date.now()): string {
  if (!ts) return 'time not recorded';
  const mins = Math.max(0, Math.round((now - new Date(ts).getTime()) / 60_000));
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}
