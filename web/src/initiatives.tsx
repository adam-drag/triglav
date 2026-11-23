// Initiatives (docs/plans/initiative-room.md): the list, and the room of one initiative with its versioned design, its
// history and the Architect chat. Block text and the Architect's replies are rendered with the safe markdown renderer
// (no raw HTML, no images, only http(s) and in-app links).
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { fmt, get, post, useData, type Json } from './api.ts';
import { ARCHITECT_CHATS, ChatComposer, ChatLog, markdown, useAction, useChat, type BlockLinks } from './chat.tsx';
import { citedLine, MAX_QUOTE, mergedGatesOf, mergedSourcesOf, popoverAt, quotableIn, quotableWhole, stepParts } from './initiative-view.ts';

const md = (s: string) => ({ __html: markdown.parse(s, { async: false }) as string });
const inline = (s: string) => ({ __html: markdown.parseInline(s, { async: false }) as string });
/** A block title's inline markdown with its links as plain text: a row's title sits inside its toggle button, and a link there would be a second control. */
const plainTitle = (s: string) => ({ __html: (markdown.parseInline(s, { async: false }) as string).replace(/<a\b[^>]*>/g, '').replace(/<\/a>/g, '') });

/** A quote chip in the Architect's composer (phase 5). The server reads the text from the stored version of `version`. */
export type Chip = { block: string; field: string; version: number; text?: string };
type ChipInput = Omit<Chip, 'version'>;
/** The most chips one message carries: the server holds the same limit (src/architect-refs.ts). The longest quote is MAX_QUOTE in initiative-view.ts. */
const MAX_CHIPS = 10;
/** The text field a Quote button quotes, per block kind. A block without one has no Quote button. */
const QUOTE_FIELD: Record<string, string> = { text: 'body', decision: 'body', open: 'body', contract: 'body', card: 'goal', wave: 'when' };
const quoteField = (b: Json): string | null => {
  const field = QUOTE_FIELD[b.kind];
  return field && typeof b[field] === 'string' && b[field] !== '' ? field : null;
};
const QuoteContext = createContext<{ version: number; add: (c: ChipInput) => void } | null>(null);
/** The merged check of each card of the current version: its PR and merge time, from the gate's evidence (phase 5). */
type Merged = { url: string | null; merged_at: string; source: string };
const MergedContext = createContext<Record<string, Merged[]>>(Object.create(null));
/** The merged checks of each card whose own job merged, keyed by that card: its PR and merge date (phase 5, Staff msg 5562). */
const SourceMergeContext = createContext<Record<string, Merged[]>>(Object.create(null));

/** The initiatives page: the cards App draws as children (with progress and what waits), and the import form. */
export function InitiativesPage({ children }: { children: ReactNode }) {
  const act = useAction();
  const [text, setText] = useState('');
  const importIt = () =>
    act.run(async () => {
      const r = await post<{ key: string }>('/api/initiatives', JSON.parse(text));
      setText('');
      location.hash = `#/initiatives/${r.key}`;
    });
  return (
    <section data-testid="initiatives">
      <div className="section-head">
        <h3>Projects</h3>
        <a className="button" href="#/new/initiative" data-testid="new-initiative-link">
          New project
        </a>
      </div>
      <p className="muted">A design shared by several jobs and repositories, with an Architect who keeps it. Open one to read its design and plan, and talk with its Architect.</p>
      {children}
      <details className="initiative-import">
        <summary>Import a project</summary>
        <p className="muted">Paste the import file (JSON with key, title, repositories, source and the design document). Triglav checks every block before it saves anything.</p>
        <textarea aria-label="Import file" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="actions">
          <button className="primary" disabled={act.busy || !text.trim()} onClick={() => void importIt()}>
            Import
          </button>
          {act.error && <span className="error">{act.error}</span>}
        </div>
      </details>
    </section>
  );
}

/** The sections of the Design tab, in order. Waves and job cards are on the Plan tab. */
const DESIGN_KINDS: [string, string][] = [
  ['text', 'Overview'],
  ['decision', 'Decisions'],
  ['open', 'Open decisions'],
  ['contract', 'Contracts'],
  ['checkpoint', 'Client checkpoints'],
  ['dod', 'Definition of done'],
];

const CARD_LISTS: [string, string][] = [
  ['scope', 'Scope'],
  ['out', 'Out of scope'],
  ['accept', 'Acceptance'],
  ['verify', 'Verify'],
  ['traps', 'Traps'],
  ['safety', 'Safety'],
  ['dod', 'Done when'],
];

function gateText(g: Json): string {
  if (g.kind === 'merged') return `${g.job} merged`;
  if (g.kind === 'deployed') return `${g.repo} deployed after ${g.after}${g.note ? ` (${g.note})` : ''}`;
  if (g.kind === 'decision') return `${g.ref} decided`;
  if (g.kind === 'milestone') return `milestone ${g.ref} started`;
  return `Client step ${g.ref} done`;
}

function Items({ items }: { items: string[] }) {
  if (!items?.length) return null;
  return (
    <ul>
      {items.map((t, i) => (
        <li key={i} dangerouslySetInnerHTML={inline(t)} />
      ))}
    </ul>
  );
}

/** What a closed block's row says after its title, so the row is useful without opening it. */
function rowNote(b: Json): string | null {
  if (b.kind === 'decision' && b.superseded_by) return `Superseded by ${b.superseded_by}`;
  if (b.kind === 'open') return b.closed ? 'Closed' : b.holds ? `Holds: ${b.holds}` : null;
  if (b.kind === 'checkpoint') return `${(b.steps as string[]).length} steps`;
  if (b.kind === 'dod') return `${(b.items as string[]).length} items`;
  return null;
}

/**
 * One block, with its id and, when it changed after the first version, the version it last changed in. With `onToggle`
 * the block is a row that shows its title until it is opened; without it the block is always open.
 */
function Block({ b, updated, open = true, onToggle, children }: { b: Json; updated: number | undefined; open?: boolean; onToggle?: () => void; children: ReactNode }) {
  const quote = useContext(QuoteContext);
  const field = quoteField(b);
  const note = onToggle ? rowNote(b) : null;
  const label = (
    <>
      <span className="block-id">{b.id}</span>
      {b.title && <strong className="block-title" dangerouslySetInnerHTML={plainTitle(b.title)} />}
      {note && <span className={`block-note${b.kind === 'open' && b.closed ? ' closed' : ''}`}>{note}</span>}
    </>
  );
  return (
    <div className={`design-block kind-${b.kind}${updated ? ' updated' : ''}${open ? ' open' : ''}${b.superseded_by ? ' superseded' : ''}`} id={`block-${b.id}`} data-testid="design-block" data-id={b.id}>
      <div className="design-block-head">
        {onToggle ? (
          <button type="button" className="block-toggle" aria-expanded={open} data-testid="block-toggle" onClick={onToggle}>
            {label}
          </button>
        ) : (
          label
        )}
        {updated && (
          <span className="updated-mark" data-testid="updated-mark">
            updated in v{updated}
          </span>
        )}
        {quote && field && (
          <button
            type="button"
            className="link quote-button"
            data-testid="quote-block"
            disabled={!quotableWhole(String(b[field]))}
            title={!quotableWhole(String(b[field])) ? `Too long to quote: select a part of the text (at most ${MAX_QUOTE} characters).` : undefined}
            onClick={() => quote.add({ block: b.id, field })}
          >
            Quote
          </button>
        )}
      </div>
      {open && <div className="block-content">{children}</div>}
    </div>
  );
}

function BlockBody({ b }: { b: Json }) {
  if (b.kind === 'text' || b.kind === 'decision' || b.kind === 'contract')
    return (
      <>
        <div className="block-body" data-block={b.id} data-field="body" dangerouslySetInnerHTML={md(b.body)} />
        {b.superseded_by && <p className="muted">Superseded by {b.superseded_by}</p>}
      </>
    );
  if (b.kind === 'open')
    return (
      <>
        {b.closed && <p className="block-closed">Closed: {b.closed}</p>}
        <div className="block-body" data-block={b.id} data-field="body" dangerouslySetInnerHTML={md(b.body)} />
        {b.options && <div className="block-body" dangerouslySetInnerHTML={md(`**Options.** ${b.options}`)} />}
        {b.rec && <div className="block-body" dangerouslySetInnerHTML={md(`**Recommendation.** ${b.rec}`)} />}
        {b.holds && <p className="muted">Holds: {b.holds}</p>}
      </>
    );
  return <Items items={b.kind === 'checkpoint' ? b.steps : b.items} />;
}

/**
 * A job card of the design, on the Plan tab. A job card's own PR and merge day come from the design only. A merged check
 * of a gate this card waits for is shown on its own line, with the card whose merge it is: that PR is not this card's PR.
 * The card whose own job merged shows the PR and date that a check stored in the gate evidence of its merge (sourced),
 * because the check writes nothing into the card. The long lists start closed, with their length, except the scope.
 */
function CardDesign({ b }: { b: Json }) {
  const checks = useContext(MergedContext)[b.id] ?? [];
  const sourced = useContext(SourceMergeContext)[b.id] ?? [];
  const pr = b.pr ?? null;
  return (
    <div className="design-card">
      <div className="design-card-facts">
        <span className="pill">{b.repo}</span> {b.size && <span className="pill">{b.size}</span>} {b.milestone && <span className="pill">milestone {b.milestone}</span>} {b.step && <span className="pill">{b.step}</span>}{' '}
        {pr && (
          <a href={pr} target="_blank" rel="noreferrer">
            PR
          </a>
        )}{' '}
        {b.merged && <span className="muted">merged {String(b.merged)}</span>}{' '}
        {sourced.map((m) => (
          <span key={`${m.url}-${m.merged_at}`} className="muted" data-testid="source-merged">
            Merged (checked):{' '}
            {m.url && (
              <a href={m.url} target="_blank" rel="noreferrer">
                PR
              </a>
            )}{' '}
            merged {fmt(m.merged_at)}
          </span>
        ))}
        {checks.map((m) => (
          <span key={m.source} className="muted" data-testid="merged-gate">
            Merged gate {m.source} (checked):{' '}
            {m.url && (
              <a href={m.url} target="_blank" rel="noreferrer">
                PR
              </a>
            )}{' '}
            merged {fmt(m.merged_at)}
          </span>
        ))}
        {b.gates?.length > 0 && <span className="muted"> Gates: {(b.gates as Json[]).map(gateText).join('; ')}</span>}
      </div>
      {b.note && <p className="muted">{b.note}</p>}
      {b.deps?.length > 0 && <p className="muted">After: {b.deps.join(', ')}</p>}
      {b.decisions?.length > 0 && <p className="muted">Decisions: {b.decisions.join(', ')}</p>}
      {b.contracts?.length > 0 && <p className="muted">Contracts: {b.contracts.join(', ')}</p>}
      {b.delivered && <p className="muted">Recorded as delivered{b.delivered.pr ? `: ${b.delivered.pr}` : ''}{b.delivered.note ? ` (${b.delivered.note})` : ''}</p>}
      <div className="block-body" data-block={b.id} data-field="goal" dangerouslySetInnerHTML={md(b.goal)} />
      {CARD_LISTS.map(([k, label]) =>
        b[k]?.length ? (
          <details key={k} className="card-list" open={k === 'scope'} data-testid="card-list" data-list={k}>
            <summary>
              {label} <span className="pill">{b[k].length}</span>
            </summary>
            <Items items={b[k]} />
          </details>
        ) : null,
      )}
    </div>
  );
}

/** A floating "Quote selection" button over a selected part of a block's text (phase 5). */
function SelectionQuote({ byId }: { byId: Map<string, Json> }) {
  const quote = useContext(QuoteContext);
  const [sel, setSel] = useState<{ block: string; field: string; text: string; top: number; left: number } | null>(null);
  useEffect(() => {
    const check = () => {
      const s = window.getSelection();
      const text = s?.toString().trim() ?? '';
      const node = s?.anchorNode;
      const host = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-block][data-field]');
      // The selection is the rendered text: it is quoted only when the stored field holds it as it is (see quotableIn).
      const stored = host ? byId.get(host.dataset.block ?? '')?.[host.dataset.field ?? ''] : undefined;
      if (!s || !text || text.length > MAX_QUOTE || !host || s.rangeCount === 0 || !quotableIn(stored, text)) return setSel(null);
      const at = popoverAt(s.getRangeAt(0).getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
      setSel({ block: host.dataset.block ?? '', field: host.dataset.field ?? '', text, top: at.top, left: at.left });
    };
    const events = ['mouseup', 'keyup', 'touchend'] as const;
    for (const ev of events) document.addEventListener(ev, check);
    return () => {
      for (const ev of events) document.removeEventListener(ev, check);
    };
  }, [byId]);
  if (!quote || !sel?.block) return null;
  return (
    <button
      type="button"
      className="quote-selection"
      data-testid="quote-selection"
      style={{ position: 'fixed', top: sel.top, left: sel.left }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        quote.add({ block: sel.block, field: sel.field, text: sel.text });
        setSel(null);
        window.getSelection()?.removeAllRanges();
      }}
    >
      Quote selection
    </button>
  );
}

/** Scrolls a block into view and flashes it once: a block name clicked in the Architect's chat. */
function reveal(el: HTMLElement) {
  el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

/** The text of a block that the Design tab's filter searches: its id and its text fields. */
function blockText(b: Json): string {
  const parts = [b.id, b.title, b.body, b.options, b.rec, b.holds, b.closed, b.superseded_by, ...((b.steps as string[] | undefined) ?? []), ...((b.items as string[] | undefined) ?? [])];
  return parts.filter((p) => typeof p === 'string').join('\n').toLowerCase();
}

/**
 * The Design tab: an outline with a filter on the left, and the sections of the design. The overview is always open; every
 * other block is a row that shows its title until it is opened, so a long design reads as a list first.
 */
function DesignTab({ data, onPlan, target, onShown }: { data: Json; onPlan: () => void; target: string | null; onShown: () => void }) {
  const [query, setQuery] = useState('');
  const [onlyUpdated, setOnlyUpdated] = useState(false);
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  // A block named in the chat: the filters are cleared and its row opens, then it is shown.
  useEffect(() => {
    if (!target) return;
    setQuery('');
    setOnlyUpdated(false);
    setOpened((s) => (s.has(target) ? s : new Set(s).add(target)));
  }, [target]);
  // Revealed only once the row is open and the filters are clear: opening it re-renders its class, which would drop the flash.
  useEffect(() => {
    const el = target && opened.has(target) && !query && !onlyUpdated ? document.getElementById(`block-${target}`) : null;
    if (!el) return;
    onShown();
    reveal(el);
  }, [target, opened, query, onlyUpdated]);
  const blocks: Json[] = data.version.doc.blocks;
  const byId = new Map(blocks.map((b) => [b.id, b]));
  // A card key is data: a copy without a prototype, so a key such as `constructor` reads no inherited member.
  const updatedIn: Record<string, number> = Object.assign(Object.create(null), data.updated_in);
  const q = query.trim().toLowerCase();
  const matches = (b: Json) => (!q || blockText(b).includes(q)) && (!onlyUpdated || updatedIn[b.id] !== undefined);
  const sections = DESIGN_KINDS.map(([kind, title]) => {
    const all = blocks.filter((b) => b.kind === kind);
    return { kind, title, all, shown: all.filter(matches) };
  }).filter((s) => s.all.length > 0);
  const cards = blocks.filter((b) => b.kind === 'card').length;
  const waves = blocks.filter((b) => b.kind === 'wave').length;
  const toggle = (id: string) =>
    setOpened((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const setAll = (ids: string[], open: boolean) =>
    setOpened((s) => {
      const next = new Set(s);
      for (const id of ids) open ? next.add(id) : next.delete(id);
      return next;
    });
  return (
    <div className="design-layout">
      <aside className="design-outline" aria-label="Design outline" data-testid="design-outline">
        <label className="design-filter">
          <span className="muted">Filter {blocks.length} blocks</span>
          <input type="search" value={query} placeholder="An id, a word or a file" data-testid="design-filter" onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label className="design-only-updated">
          <input type="checkbox" checked={onlyUpdated} data-testid="design-only-updated" onChange={(e) => setOnlyUpdated(e.target.checked)} /> Only blocks changed after the first version
        </label>
        <nav className="outline-links">
          {sections.map((s) => {
            const waiting = s.kind === 'open' ? s.all.filter((b) => !b.closed).length : 0;
            return (
              <button key={s.kind} type="button" className="outline-link" data-testid="outline-link" data-kind={s.kind} onClick={() => document.getElementById(`section-${s.kind}`)?.scrollIntoView({ block: 'start' })}>
                <span>{s.title}</span>
                <span className={`pill${waiting ? ' outline-waiting' : ''}`} title={waiting ? `${waiting} not decided` : undefined}>
                  {q || onlyUpdated ? `${s.shown.length} of ${s.all.length}` : s.all.length}
                </span>
              </button>
            );
          })}
          {cards > 0 && (
            <button type="button" className="outline-link outline-plan" data-testid="outline-plan" onClick={onPlan}>
              <span>Waves and job cards</span>
              <span className="muted">
                {waves} · {cards} on Plan
              </span>
            </button>
          )}
        </nav>
      </aside>
      <div className="design" data-testid="design">
        <SelectionQuote byId={byId} />
        {sections.map(({ kind, title, all, shown }) => {
          const rows = kind !== 'text';
          const ids = shown.map((b) => b.id as string);
          const allOpen = ids.length > 0 && ids.every((id) => opened.has(id));
          return (
            <div key={kind} className="design-section" id={`section-${kind}`} data-testid="design-section" data-kind={kind}>
              <div className="design-section-head">
                <h4>{title}</h4>
                <span className="muted">{shown.length === all.length ? all.length : `${shown.length} of ${all.length}`}</span>
                {rows && ids.length > 0 && (
                  <button type="button" className="link" data-testid="section-toggle-all" onClick={() => setAll(ids, !allOpen)}>
                    {allOpen ? 'Close all' : 'Open all'}
                  </button>
                )}
              </div>
              {shown.length === 0 && <p className="muted design-none">No block here matches the filter.</p>}
              {shown.map((b) =>
                rows ? (
                  <Block key={b.id} b={b} updated={updatedIn[b.id]} open={opened.has(b.id)} onToggle={() => toggle(b.id)}>
                    <BlockBody b={b} />
                  </Block>
                ) : (
                  <Block key={b.id} b={b} updated={updatedIn[b.id]}>
                    <BlockBody b={b} />
                  </Block>
                ),
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const TRIGGER: Record<string, string> = { import: 'Imported', create: 'Created', research: 'Created from a research report', chat: 'Confirmed in the room' };

/** One version in History: its trigger, and the block changes when opened. */
function VersionRow({ k, v }: { k: string; v: Json }) {
  const [diff, setDiff] = useState<Json | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <details
      className="history-row"
      data-testid="history-row"
      data-version={v.version}
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open && !diff)
          get<Json>(`/api/initiatives/${k}/versions/${v.version}/diff`)
            .then(setDiff)
            .catch((x) => setError((x as Error).message));
      }}
    >
      <summary>
        <strong>v{v.version}</strong> <span data-testid="history-trigger">{TRIGGER[v.trigger_kind] ?? v.trigger_kind}</span>
        {v.trigger_ref && <span className="muted"> ({v.trigger_ref})</span>} <span className="muted">{fmt(v.created_at)}</span>
        <div>{v.summary}</div>
        {v.trigger_kind !== 'import' && v.changed?.length > 0 && <div className="muted">Changed: {v.changed.join(', ')}</div>}
      </summary>
      {error && <p className="error">{error}</p>}
      {diff && !diff.blocks.length && <p className="muted">The first version: nothing to compare with.</p>}
      {diff && <DiffBlocks blocks={diff.blocks} />}
    </details>
  );
}

/** Block changes, field by field, as plain text (the old value, then the new one). */
function DiffBlocks({ blocks }: { blocks: Json[] }) {
  const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  return (
    <>
      {blocks.map((b: Json) => (
        <div key={b.id} className="diff-block">
          <strong>
            {b.change} {b.id}
          </strong>{' '}
          {b.title}
          {(b.fields as Json[]).map((f) => (
            <div key={f.field} className="diff-field">
              <span className="muted">{f.field}</span>
              {f.before != null && <pre className="diff-before">{show(f.before)}</pre>}
              {f.after != null && <pre className="diff-after">{show(f.after)}</pre>}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

/** A revision the Architect asked for and the Client has not answered: every change in full, beside the card in the chat. */
function PendingRevision({ k, r }: { k: string; r: Json }) {
  const [view, setView] = useState<Json | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const load = () =>
    get<Json>(`/api/initiatives/${k}/revisions/${r.id}`)
      .then(setView)
      .catch((x) => setError((x as Error).message));
  // The Client keeps a met gate met through this revision, with a reason; the gate then stays met when the revision is confirmed.
  const keep = (c: Json) => {
    const id = `${c.card_key}|${c.gate_key}`;
    post(`/api/initiatives/${k}/revisions/${r.id}/keep-met`, { card_key: c.card_key, gate_key: c.gate_key, reason: (reasons[id] ?? '').trim() })
      .then(load)
      .catch((x) => setError((x as Error).message));
  };
  return (
    <details
      className="history-row pending-revision"
      data-testid="pending-revision"
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open && !view) void load();
      }}
    >
      <summary>
        <strong>Waiting for you</strong> <span className="muted">on v{r.base_version}</span>
        <div>{r.summary}</div>
        <div className="muted">Confirm or deny it on its card in the Architect chat.</div>
      </summary>
      {error && <p className="error">{error}</p>}
      {view && <DiffBlocks blocks={view.blocks} />}
      {view?.met_changes?.map((c: Json) => {
        const id = `${c.card_key}|${c.gate_key}`;
        if (c.new_text === null)
          return (
            <p key={id} className="muted" data-testid="met-change">
              Met gate {c.gate_key} of {c.card_key} is removed, so its mark clears.
            </p>
          );
        if (c.kept)
          return (
            <p key={id} className="muted" data-testid="met-change">
              Met gate {c.gate_key} of {c.card_key} changes its text, and you kept it met.
            </p>
          );
        return (
          <div key={id} className="met-change" data-testid="met-change">
            <p>
              Met gate {c.gate_key} of {c.card_key} changes its text, from &quot;{c.old_text}&quot; to &quot;{c.new_text}&quot;. It reopens unless you keep it met.
            </p>
            <label>
              Reason{' '}
              <input value={reasons[id] ?? ''} maxLength={500} onChange={(e) => setReasons({ ...reasons, [id]: e.target.value })} data-testid="keep-met-reason" />
            </label>{' '}
            <button type="button" data-testid="keep-met" disabled={!(reasons[id] ?? '').trim()} onClick={() => keep(c)}>
              Keep met
            </button>
          </div>
        );
      })}
    </details>
  );
}

function HistoryTab({ data }: { data: Json }) {
  return (
    <div className="history" data-testid="history">
      {(data.revisions as Json[])
        .filter((r) => r.state === 'pending')
        .map((r) => (
          <PendingRevision key={r.id} k={data.initiative.key} r={r} />
        ))}
      {(data.keeps as Json[] | undefined)?.map((g) => (
        <div key={`${g.card_key}|${g.gate_key}|${g.created_at}`} className="history-row" data-testid="history-keep">
          <strong>Kept met</strong> <span className="muted">{fmt(g.created_at)}</span>
          <div>
            {g.card_key}, gate {g.gate_key}: the Client kept it met through a revision that changes its text. Reason: {g.reason}
          </div>
          <div className="muted">Old text: {g.old_text ?? '(none)'}</div>
          <div className="muted">New text: {g.new_text ?? '(none)'}</div>
        </div>
      ))}
      {(data.versions as Json[]).map((v) => (
        <VersionRow key={v.version} k={data.initiative.key} v={v} />
      ))}
    </div>
  );
}

type OverlapWarning = { job_id: string; card: string | null; head_sha: string; heads: string[]; reviewed_at: string; source: string | null; truncated: boolean; paths: string[] };
type Overlap = { running: number; likely: string[]; likely_truncated: boolean; warnings: OverlapWarning[]; no_data: string[]; incomplete: string[] };

/** When the warning's data was reviewed: one head, or the parts of a split card with the oldest time. */
function reviewedText(w: OverlapWarning): string {
  const at = new Date(w.reviewed_at).toLocaleString();
  return w.heads.length > 1 ? `as of ${w.heads.length} distinct heads of its parts (${w.heads.map((h) => h.slice(0, 12)).join(', ')}), the oldest at ${at}` : `as of its review of ${w.head_sha.slice(0, 12)} at ${at}`;
}

/** What a review's base source means for its list: the rules commit it was read at, and so what the list may miss or add. */
function sourceNote(source: string | null): string {
  if (source === 'local') return 'The list was read from the local branch, not from origin, so it may include changes from other work.';
  if (source === 'base_sha') return 'The list was read from the base commit of that review, not from origin, so it may leave out files that earlier rounds of the job changed.';
  return 'The list was not read from origin, so it may be incomplete or include changes from other work.';
}

/**
 * The file overlap warning on Start. Only a warning: Start still works. Paths and job ids are text, never markup. The text
 * says what the data is: the newest review run that sent a list, and how old it is.
 */
function OverlapNote({ overlap }: { overlap: Overlap }) {
  if (!overlap.running) return null;
  if (!overlap.likely.length) {
    if (overlap.likely_truncated) return <p className="muted" data-testid="overlap-card-cut">The card's text is too long to check for file paths, so its overlap with the running jobs of this project cannot be checked.</p>;
    return <p className="muted" data-testid="overlap-none">This card names no file paths, so its overlap with the running jobs of this project cannot be checked.</p>;
  }
  return (
    <div data-testid="overlap">
      {overlap.likely_truncated && <p className="muted" data-testid="overlap-card-cut">The card's list of file paths was cut: the check reads at most 4000 characters of each field and 200 paths. A file the card names after the cut is not checked.</p>}
      {overlap.warnings.length > 0 && <p className="muted">This is a warning. Start still works.</p>}
      {overlap.warnings.map((w) => (
        <div className="warn-note" key={w.job_id} data-testid="overlap-warning">
          <p>
            Job {w.job_id} started from this project changed {w.paths.length === 1 ? 'a file this card names' : `${w.paths.length} files this card names`}, {reviewedText(w)}.
          </p>
          <ul>
            {w.paths.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
          {w.source !== 'origin' && <p>{sourceNote(w.source)}</p>}
          {w.truncated && <p>The list of changed files was cut, so this job may touch more files than shown.</p>}
        </div>
      ))}
      {overlap.no_data.length > 0 && <p className="muted">{overlap.no_data.length === 1 ? 'A running job has' : `${overlap.no_data.length} running jobs have`} no finished review with a file list yet, or part of its work has none, so some or all of their files are not checked.</p>}
      {overlap.incomplete.length > 0 && <p className="muted">A running job's list of changed files was cut, or was read at a base other than origin, and it shows no overlap, so it may still touch a file this card names.</p>}
    </div>
  );
}
type Preview = { can_start: boolean; state: string; reasons: string[]; prompt: string | null; started_from_version: number; repo: Json; warning: string | null; overlap: Overlap };

const STATE_TEXT: Record<string, string> = { delivered: 'Delivered', running: 'Running', ready: 'Ready', your_step: 'Your step', locked: 'Locked' };

function cardStateText(c: Json): string {
  if (c.state === 'running') return `Running (${c.phase === 'starting' ? 'starting' : String(c.phase).replaceAll('_', ' ')})`;
  return STATE_TEXT[c.state] ?? String(c.state);
}

/** What the gate's last check or mark says, in plain words. The PR link is only a GitHub link. */
function evidenceOf(g: Json): { text: string; url: string | null } | null {
  const e = g.evidence;
  if (!e) return null;
  const url = typeof e.url === 'string' && /^https:\/\/github\.com\//.test(e.url) ? e.url : null;
  // No check result is used for a refusal (for example no delivery yet, or a second pull request). A met gate does not show it.
  if (typeof e.not_checked === 'string') return g.met ? null : { text: `Not checked: ${e.not_checked}`, url: null };
  if (typeof e.error === 'string') return { text: `The last check failed: ${e.error}`, url };
  if (e.state === 'OPEN' || e.state === 'CLOSED') return { text: `The last check found the pull request ${String(e.state).toLowerCase()}.`, url };
  if (typeof e.merged_at === 'string') return { text: `Merged ${fmt(e.merged_at)}, merge commit ${String(e.merge_commit ?? '').slice(0, 7)}.`, url };
  return null;
}

/** A column of the wave map: one wave, a run of folded delivered waves, or the cards in no wave. */
type PlanColumn = { id: string; title: string; when?: string; cards: Json[]; folded?: Json[] };
type PlanGroup = { milestone: string | null; columns: PlanColumn[]; total: number; delivered: number };

/**
 * The wave map's groups: one per milestone, in the order the waves first name it, each with its waves as columns. A wave
 * belongs to the milestone of its first card that has one. With `fold`, delivered waves fold (foldDelivered).
 */
function planGroups(blocks: Json[], live: Map<string, Json>, fold: boolean): PlanGroup[] {
  const cards = new Map(blocks.filter((b) => b.kind === 'card').map((b) => [b.id as string, b]));
  const groups = new Map<string | null, PlanGroup>();
  const groupOf = (m: string | null) => {
    if (!groups.has(m)) groups.set(m, { milestone: m, columns: [], total: 0, delivered: 0 });
    return groups.get(m)!;
  };
  const placed = new Set<string>();
  for (const w of blocks.filter((b) => b.kind === 'wave')) {
    const list = (w.jobs as string[]).map((j) => cards.get(j)).filter((c): c is Json => !!c);
    for (const c of list) placed.add(c.id);
    groupOf(list.find((c) => c.milestone)?.milestone ?? null).columns.push({ id: w.id, title: w.title, when: w.when, cards: list });
  }
  const loose = [...cards.values()].filter((c) => !placed.has(c.id));
  if (loose.length) groupOf(null).columns.push({ id: 'no-wave', title: 'In no wave', cards: loose });
  for (const g of groups.values()) {
    const all = g.columns.flatMap((c) => c.cards);
    g.total = all.length;
    g.delivered = all.filter((c) => live.get(c.id)?.state === 'delivered').length;
    if (fold) g.columns = foldDelivered(g.columns, live);
  }
  return [...groups.values()];
}

/** Each run of waves whose cards are all delivered becomes one folded column, in its place. */
function foldDelivered(columns: PlanColumn[], live: Map<string, Json>): PlanColumn[] {
  const done = (c: PlanColumn) => c.cards.length > 0 && c.cards.every((x) => live.get(x.id)?.state === 'delivered');
  const out: PlanColumn[] = [];
  let run: PlanColumn[] = [];
  const flush = () => {
    if (!run.length) return;
    const title = run.length === 1 ? run[0]!.title : `${run[0]!.title} to ${run[run.length - 1]!.title}`;
    out.push({ id: `folded-${run[0]!.id}`, title, cards: [], folded: run.flatMap((c) => c.cards) });
    run = [];
  };
  for (const c of columns) {
    if (done(c)) run.push(c);
    else {
      flush();
      out.push(c);
    }
  }
  flush();
  return out;
}

/** The cards that wait for `key`: a merged gate on its job, a deployed gate after it, or `key` among their deps. */
function unlockedBy(blocks: Json[], key: string): string[] {
  const waits = (g: Json) => (g.kind === 'merged' && g.job === key) || (g.kind === 'deployed' && g.after === key);
  return blocks.filter((b) => b.kind === 'card' && ((b.gates as Json[] | undefined)?.some(waits) || (b.deps as string[] | undefined)?.includes(key))).map((b) => b.id as string);
}

/** A wave of the design, on the Plan tab: when it runs, the checkpoint after it, and its cards. */
function WaveDesign({ w, byId, onPick }: { w: Json; byId: Map<string, Json>; onPick: (id: string) => void }) {
  const checkpoint = w.checkpoint ? byId.get(w.checkpoint) : undefined;
  return (
    <>
      <p className="block-body" data-block={w.id} data-field="when">
        {w.when}
      </p>
      {w.checkpoint && (
        <p className="muted" data-testid="wave-checkpoint">
          Then Client checkpoint {w.checkpoint}
          {checkpoint?.title ? `: ${checkpoint.title}` : ''}.
        </p>
      )}
      <div className="plan-unlocks">
        {(w.jobs as string[]).map((j) => (
          <button key={j} type="button" className="chip" onClick={() => onPick(j)}>
            {j}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * The Plan tab: the job cards as a map, a column per wave and a group per milestone, and the selected card's design and
 * job controls below it. Card states, gates and Start are for the current version only; an older version shows its map.
 */
function PlanTab({ k, data, current, version, onChanged, target, onShown }: { k: string; data: Json; current: boolean; version: number; onChanged: () => void; target: string | null; onShown: () => void }) {
  const { data: jobs, error, reload } = useData<Json>(`/api/initiatives/${k}/jobs`, version);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [fold, setFold] = useState(true);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  // A merged check lands in the scheduler, which does not announce it to the room, so the tab reads again every 30 s, and
  // the room reads the initiative too: a check also writes a design version. The interval is armed once; the latest
  // reload and onChanged are read through refs, since they change on every render.
  const reloadRef = useRef(reload);
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    reloadRef.current = reload;
    onChangedRef.current = onChanged;
  }, [reload, onChanged]);
  useEffect(() => {
    const t = window.setInterval(() => {
      reloadRef.current();
      onChangedRef.current();
    }, 30_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => setSelected(null), [k]);
  // A card or wave named in the chat: the map shows every card, a card is picked, then the block is shown.
  useEffect(() => {
    const kind = target ? (data.version.doc.blocks as Json[]).find((b) => b.id === target)?.kind : undefined;
    if (kind !== 'card' && kind !== 'wave') return;
    setSelected(target);
    setFold(false);
    setQuery('');
    setHidden(new Set());
  }, [target]);
  // Revealed only once the map shows every card and the card is picked, so no later render redraws it without the flash.
  useEffect(() => {
    const kind = target ? (data.version.doc.blocks as Json[]).find((b) => b.id === target)?.kind : undefined;
    const settled = !fold && !query && hidden.size === 0 && (kind === undefined || selected === target);
    const el = target && settled ? document.getElementById(`block-${target}`) : null;
    if (!el) return;
    onShown();
    reveal(el);
  }, [target, selected, fold, query, hidden, jobs, data]);
  if (error) return <p className="error">{error}</p>;
  if (current && !jobs) return <p className="muted">Loading...</p>;
  const blocks: Json[] = data.version.doc.blocks;
  const updatedIn: Record<string, number> = Object.assign(Object.create(null), data.updated_in);
  // The job states are the current version's: an older version's map shows no state. The design and /jobs load on their
  // own, so the states show only while both are the same version (a new version reloads both, one after the other).
  const live = new Map<string, Json>(current && jobs && jobs.version === data.version.version ? (jobs.cards as Json[]).map((c) => [c.key as string, c]) : []);
  const groups = planGroups(blocks, live, fold);
  const q = query.trim().toLowerCase();
  const dim = (c: Json) => !!q && !`${c.id}\n${c.title}`.toLowerCase().includes(q);
  // The picked block: a card, or a wave picked by its column's head.
  const sel = selected ? blocks.find((b) => (b.kind === 'card' || b.kind === 'wave') && b.id === selected) : undefined;
  const unlocks = sel?.kind === 'card' ? unlockedBy(blocks, sel.id) : [];
  const byId = new Map(blocks.map((b) => [b.id as string, b]));
  const changed = () => {
    reload();
    onChanged();
  };
  // Each milestone a gate waits for, once: the Client starts it here. The server lists the started ones.
  const started: string[] = jobs?.milestones_started ?? [];
  const waiting = current && jobs && jobs.version === data.version.version ? [...new Set<string>(jobs.cards.flatMap((c: Json) => c.gates.filter((g: Json) => g.kind === 'milestone').map((g: Json) => String(g.key).slice('milestone:'.length))))].filter((ref) => !started.includes(ref)) : [];
  const milestones = groups.map((g) => g.milestone).filter((m): m is string => m !== null);
  const tile = (c: Json) => {
    const j = live.get(c.id);
    // A locked card that waits for a milestone nobody started is drawn dashed: its part of the plan has not begun.
    const later = j?.state === 'locked' && (j.gates as Json[]).some((g) => g.kind === 'milestone' && !g.met);
    const cls = ['plan-tile', `st-${j?.state ?? 'none'}`, later ? 'later' : '', unlocks.includes(c.id) ? 'unlocks' : '', dim(c) ? 'dim' : ''].filter(Boolean).join(' ');
    return (
      <button key={c.id} type="button" className={cls} aria-pressed={selected === c.id} data-testid="plan-tile" data-key={c.id} data-state={j?.state ?? ''} onClick={() => setSelected(selected === c.id ? null : c.id)}>
        <span className="plan-tile-head">
          <span className="job-key">{c.id}</span>
          {c.size && <span className="pill">{c.size}</span>}
        </span>
        <span className="plan-tile-title">{c.title}</span>
        {j && (
          <span className="plan-tile-state" data-testid="tile-state">
            {cardStateText(j)}
          </span>
        )}
      </button>
    );
  };
  return (
    <div className="plan" data-testid="plan">
      {waiting.length > 0 && (
        <section className="milestones" data-testid="milestones">
          {waiting.map((ref) => (
            <MilestoneStart key={ref} k={k} milestone={ref} onChanged={changed} />
          ))}
        </section>
      )}
      {current && jobs && (
        <p className="muted jobs-summary" data-testid="jobs-running">
          {jobs.running} of {jobs.cap} implementation jobs from this project are running.
        </p>
      )}
      {current && jobs && jobs.running >= jobs.cap && (
        <p className="warn-note" data-testid="jobs-cap">
          The cap is reached. A Start still works, and it adds one more running job.
        </p>
      )}
      {!current && <p className="muted">This is an older version. Card states and Start are on the current version.</p>}
      <div className="plan-toolbar">
        <input type="search" aria-label="Filter cards" placeholder={`Filter ${live.size || blocks.filter((b) => b.kind === 'card').length} cards`} value={query} data-testid="plan-filter" onChange={(e) => setQuery(e.target.value)} />
        {milestones.length > 1 &&
          milestones.map((m) => (
            <button key={m} type="button" className="chip" aria-pressed={!hidden.has(m)} data-testid="plan-milestone" onClick={() => setHidden((h) => (h.has(m) ? new Set([...h].filter((x) => x !== m)) : new Set([...h, m])))}>
              Milestone {m}
            </button>
          ))}
        {current && (
          <button type="button" className="chip" aria-pressed={fold} data-testid="plan-fold-toggle" onClick={() => setFold(!fold)}>
            Fold delivered waves
          </button>
        )}
        {current && (
          <span className="plan-legend muted">
            <span className="legend st-delivered">Delivered</span>
            <span className="legend st-ready">Ready</span>
            <span className="legend st-running">Running</span>
            <span className="legend st-your_step">Your step</span>
            <span className="legend st-locked">Locked</span>
            {sel && <span className="legend unlocks">Waits for the selected card</span>}
          </span>
        )}
      </div>
      <div className="plan-map" data-testid="plan-map">
        {groups
          .filter((g) => g.milestone === null || !hidden.has(g.milestone))
          .map((g) => (
            <div key={g.milestone ?? ''} className="plan-group" data-testid="plan-group">
              <div className="plan-group-head">
                {g.milestone === null ? (milestones.length ? 'No milestone' : 'Job cards') : `Milestone ${g.milestone}`}
                {current && (
                  <span className="muted">
                    {' '}
                    · {g.delivered} of {g.total} delivered
                  </span>
                )}
              </div>
              <div className="plan-columns">
                {g.columns.map((col) => (
                  <div key={col.id} className="plan-column" data-testid="plan-column">
                    {col.folded || col.id === 'no-wave' ? (
                      <div className="plan-column-head">{col.title}</div>
                    ) : (
                      <button type="button" className="plan-column-head plan-wave" aria-pressed={selected === col.id} data-testid="plan-wave" data-key={col.id} title={col.when} onClick={() => setSelected(selected === col.id ? null : col.id)}>
                        {col.title}
                      </button>
                    )}
                    {col.folded ? (
                      <button type="button" className="plan-tile plan-folded" data-testid="plan-folded" onClick={() => setFold(false)}>
                        <span className="plan-tile-title">{col.folded.length === 1 ? '1 card delivered' : `${col.folded.length} cards delivered`}</span>
                        <span className="plan-squares" aria-hidden="true">
                          {col.folded.map((c) => (
                            <span key={c.id} />
                          ))}
                        </span>
                        <span className="muted">Show them</span>
                      </button>
                    ) : (
                      col.cards.map(tile)
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
      </div>
      <SelectionQuote byId={byId} />
      {!sel && <p className="muted plan-hint">Pick a card on the map to see its design, its gates and Start, or a wave's name to see when it runs.</p>}
      {sel?.kind === 'wave' && (
        <section className="plan-card" data-testid="plan-card" data-key={sel.id}>
          <div className="plan-card-design">
            <Block b={sel} updated={updatedIn[sel.id]}>
              <WaveDesign w={sel} byId={byId} onPick={setSelected} />
            </Block>
          </div>
        </section>
      )}
      {sel?.kind === 'card' && (
        <section className="plan-card" data-testid="plan-card" data-key={sel.id}>
          <div className="plan-card-design">
            <Block b={sel} updated={updatedIn[sel.id]}>
              <CardDesign key={sel.id} b={sel} />
            </Block>
          </div>
          <div className="plan-card-job">
            {live.get(sel.id) ? <CardRow key={sel.id} k={k} c={live.get(sel.id)!} onChanged={changed} compact /> : current && <p className="muted">This card has no job state yet.</p>}
            {unlocks.length > 0 && (
              <div className="plan-unlocks" data-testid="plan-unlocks">
                <h5>Waiting for this card</h5>
                {unlocks.map((u) => (
                  <button key={u} type="button" className="chip" onClick={() => setSelected(u)}>
                    {u}
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/** A milestone that no card has started yet. The Client confirms the start, and the design gets a version. */
function MilestoneStart({ k, milestone, onChanged }: { k: string; milestone: string; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const act = useAction();
  if (!confirming) {
    return (
      <button type="button" className="link" data-testid="milestone-start" onClick={() => setConfirming(true)}>
        Start milestone {milestone}
      </button>
    );
  }
  return (
    <p className="milestone-confirm" data-testid="milestone-confirm">
      Start milestone {milestone}? The milestone gates that name it are met from then on.{' '}
      <button
        type="button"
        data-testid="milestone-start-submit"
        disabled={act.busy}
        onClick={() =>
          void act.run(async () => {
            await post(`/api/initiatives/${k}/milestones/${encodeURIComponent(milestone)}/start`, {});
            setConfirming(false);
            onChanged();
          })
        }
      >
        Start milestone {milestone}
      </button>{' '}
      <button type="button" className="link" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </p>
  );
}

/**
 * The steps of a checkpoint. A step whose text holds a code span has a prepared command: the first span is shown, with a
 * Copy button that only copies it to the clipboard. Nothing in the dashboard runs a command.
 */
function StepList({ steps }: { steps: string[] }) {
  if (steps.length === 0) return <p className="muted">This checkpoint has no steps.</p>;
  return (
    <ol className="step-list" data-testid="step-list">
      {steps.map((s, n) => {
        const { text, command } = stepParts(s);
        return (
          <li key={n}>
            <span>{text}</span>
            {command && <CopyCommand command={command} />}
          </li>
        );
      })}
    </ol>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <span className="copy-command">
      <code>{command}</code>{' '}
      <button
        type="button"
        className="link"
        data-testid="copy-command"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setState('copied');
          } catch {
            setState('failed');
          }
        }}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
      </button>
    </span>
  );
}

/** A card's job: its state, gates, change since start and Start. `compact` leaves out the key and title, which the Plan tab shows beside it. */
function CardRow({ k, c, onChanged, compact = false }: { k: string; c: Json; onChanged: () => void; compact?: boolean }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [markKey, setMarkKey] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [started, setStarted] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [dismissReason, setDismissReason] = useState('');
  const act = useAction();
  const base = `/api/initiatives/${k}/cards/${encodeURIComponent(c.key)}`;

  const openStart = () => {
    setStarted(null);
    void act.run(async () => setPreview(await get<Preview>(`${base}/start`)));
  };
  const startJob = (version: number) =>
    void act.run(async () => {
      const r = await post<Json>(`${base}/start`, { started_from_version: version });
      setPreview(null);
      setStarted(`Started a job from design version ${r.started_from_version}.`);
      onChanged();
    });
  const markGate = (g: Json) =>
    void act.run(async () => {
      await post(`${base}/gates/${encodeURIComponent(g.key)}/mark`, { reason: reason.trim() });
      setMarkKey(null);
      setReason('');
      onChanged();
    });
  // A logged dismiss of the card's change since its start. The Architect's addendum clears the same mark when it is confirmed.
  const dismissChange = () =>
    void act.run(async () => {
      await post(`${base}/dismiss-change`, { reason: dismissReason.trim() });
      setDismissing(false);
      setDismissReason('');
      onChanged();
    });

  const ev = (g: Json) => evidenceOf(g);
  return (
    <article className={`job-card${compact ? ' compact' : ''}`} data-testid="job-card" data-key={c.key} data-state={c.state}>
      <div className="job-card-head">
        {compact ? (
          <strong className="job-card-title">Job</strong>
        ) : (
          <>
            <span className="job-key">{c.key}</span>
            <strong>{c.title}</strong>
          </>
        )}
        <span className="pill">{c.repo}</span>
        <span className={`pill job-state state-${c.state}`} data-testid="job-state">
          {cardStateText(c)}
        </span>
      </div>
      {c.recorded && (
        <p className="muted" data-testid="job-recorded">
          Recorded in the design, not checked.
        </p>
      )}
      {c.changed_since_start && (
        <div className="job-changed" data-testid="job-changed">
          <strong>Changed since start.</strong>{' '}
          <span className="muted">{(c.change?.fields ?? []).map((f: Json) => `${f.field}: ${JSON.stringify(f.before)} to ${JSON.stringify(f.after)}`).join('; ')}</span>
          {!dismissing && (
            <button type="button" className="link" data-testid="job-dismiss-change" onClick={() => setDismissing(true)}>
              Dismiss
            </button>
          )}
          {dismissing && (
            <form
              data-testid="job-dismiss-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (dismissReason.trim()) dismissChange();
              }}
            >
              <label>
                Reason <input value={dismissReason} onChange={(e) => setDismissReason(e.target.value)} />
              </label>{' '}
              <button type="submit" disabled={!dismissReason.trim()}>
                Log dismiss
              </button>
            </form>
          )}
        </div>
      )}
      {c.gates.length > 0 && (
        <ul className="gate-list">
          {c.gates.map((g: Json) => (
            <li key={g.key} data-testid="gate-row" data-met={g.met ? 'yes' : 'no'}>
              <span className={g.met ? 'gate-met' : 'gate-open'}>{g.met ? 'Met' : 'Open'}</span> {g.label}
              {g.met && g.met_by && <span className="muted"> ({g.met_by === 'check' ? 'checked on GitHub' : 'marked by the Client'})</span>}
              {g.met && g.reason && <span className="muted"> Reason: {g.reason}</span>}
              {g.reopened && <span className="muted"> Open again: the checkpoint changed after the mark.</span>}
              {ev(g) && (
                <span className="muted gate-evidence">
                  {' '}
                  {ev(g)!.text}
                  {ev(g)!.url && (
                    <>
                      {' '}
                      <a href={ev(g)!.url!} target="_blank" rel="noreferrer">
                        Pull request
                      </a>
                    </>
                  )}
                </span>
              )}
              {g.markable && !g.met && markKey !== g.key && (
                <button type="button" className="link" data-testid="gate-mark" onClick={() => (setMarkKey(g.key), setReason(''))}>
                  Mark met
                </button>
              )}
              {markKey === g.key && (
                <form
                  className="gate-mark-form"
                  data-testid="gate-mark-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (reason.trim()) markGate(g);
                  }}
                >
                  <label>
                    Reason
                    <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required data-testid="gate-reason" />
                  </label>
                  <button type="submit" data-testid="gate-mark-submit" disabled={!reason.trim() || act.busy}>
                    Mark met
                  </button>{' '}
                  <button type="button" className="link" onClick={() => setMarkKey(null)}>
                    Cancel
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {(c.gates as Json[]).filter((g) => g.kind === 'client_step' && !g.met).map((g) => (
        <div key={g.key} className="your-step" data-testid="your-step">
          <h5>Your step: {g.label}</h5>
          <StepList steps={(c.steps?.[g.key] ?? []) as string[]} />
        </div>
      ))}
      {c.state === 'locked' && <p className="muted">{c.open} open {c.open === 1 ? 'gate' : 'gates'} before this card can start.</p>}
      {started && <p className="muted" data-testid="job-started">{started}</p>}
      {c.state === 'ready' && !preview && c.start_block && <p className="error" data-testid="job-start-block">{c.start_block}</p>}
      {compact && c.state === 'ready' && !preview && !c.start_block && !started && (
        <p className="muted job-ready-note">Every gate is met. Start shows the prompt it sends first, and nothing runs until you confirm it.</p>
      )}
      {c.state === 'ready' && !preview && !c.start_block && (
        <button type="button" className={compact ? 'primary job-start' : undefined} data-testid="card-start" onClick={openStart} disabled={act.busy}>
          Start
        </button>
      )}
      {preview && (
        <div className="start-confirm" data-testid="start-confirm">
          {preview.warning && <p className="warn-note">{preview.warning}</p>}
          <OverlapNote overlap={preview.overlap} />
          {!preview.can_start && <p className="error">{preview.reasons.join(' ') || 'This card cannot start now.'}</p>}
          {preview.can_start && (
            <>
              <p className="muted">
                This sends the prompt below as a new job on {preview.repo?.slug}, from design version {preview.started_from_version}.
              </p>
              <pre className="start-prompt" data-testid="start-prompt">
                {preview.prompt}
              </pre>
              <div>
                <button type="button" className="primary" data-testid="start-confirm-button" onClick={() => startJob(preview.started_from_version)} disabled={act.busy}>
                  Start job
                </button>{' '}
                <button type="button" className="link" onClick={() => setPreview(null)}>
                  Cancel
                </button>
              </div>
            </>
          )}
          {!preview.can_start && (
            <button type="button" className="link" onClick={() => setPreview(null)}>
              Close
            </button>
          )}
        </div>
      )}
      {act.error && <p className="error">{act.error}</p>}
    </article>
  );
}

/** An answer the Architect wrote for a Staff question, or an escalation waiting for the Client. The answer is plain text. */
export type AnswerRow = { id: string; initiative_key?: string; blocker_id?: string | null; job_id: string; answer: string; citation: Json; state: string; target: string; refusal: string | null; created_at: string; decided_at?: string | null; design_version?: number; question?: string | null; context?: string | null };

/** The citation of an answer: a decision, or a line at a commit with the time it was checked (phase 5, criterion 5). */
function Cited({ citation, checkedAt }: { citation: Json; checkedAt: string | null }) {
  const code = citation?.code as Json | undefined;
  // The age counts on while the Inbox is open, so the line is drawn again every minute.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  if (code)
    return (
      <>
        <div className="muted cited-fact" data-testid="cited-fact">
          {citedLine(code, checkedAt)}
        </div>
        {typeof code.quote === 'string' && (
          <div className="muted cited-quote" data-testid="cited-quote">
            Quote: {code.quote}
          </div>
        )}
      </>
    );
  if (typeof citation?.decision === 'string') return <div className="muted cited-fact" data-testid="cited-fact">Cited: design decision {citation.decision}</div>;
  // A research report version: research output, not checked by a person. The text was checked against the stored body by the server.
  const report = citation?.report as { job_id?: unknown; version?: unknown } | undefined;
  if (report && typeof report.job_id === 'string') return <div className="muted cited-fact" data-testid="cited-fact">Cited: research report {report.job_id} version {String(report.version)} (research, unverified by a person)</div>;
  return null;
}

/** One auto decision of the Architect, as GET /api/initiatives/:key/auto-mode lists it (src/architect-answers.ts autoDecisionsOf). */
export type AutoDecision = { id: string; blocker_id: string | null; answer: string; citation: Json; state: string; decision_kind: string | null; hold_until: string | null; reviewed_at: string | null; refusal: string | null; created_at: string; decided_at: string | null; blocker_kind: string | null; question: string | null; undoable: boolean };
type AutoView = { on: boolean; until: string | null; decisions: AutoDecision[] };

/** The states of a decision the Client may still want to look at: it waits, or Staff has it. Undone, taken back and not sent ones are settled. */
const AUTO_TO_REVIEW = ['held', 'checking', 'posted'];

const AUTO_STATE: Record<string, string> = {
  held: 'Waits before Staff sees it',
  checking: 'Waits for the code check',
  posted: 'Sent to Staff',
  undone: 'Undone by you',
  refused: 'Not sent',
  reopened: 'Taken back by you: it waits for your decision',
};

/**
 * The auto mode switch in the room's head. While auto mode is on, a ring turns slowly around it, and it pulses once when a
 * new decision of the Architect arrives (still under reduced motion: styles.css). Switching it on asks once more and says
 * what it means; switching it off does not.
 */
function AutoModeSwitch({ k, view, onChanged }: { k: string; view: AutoView | null; onChanged: () => void }) {
  const act = useAction();
  const [asking, setAsking] = useState(false);
  const [pulse, setPulse] = useState(false);
  const loaded = view !== null;
  const newest = view?.decisions[0]?.id ?? null;
  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!loaded) return;
    // The first load records what was already there; only a decision that arrives later pulses.
    if (seen.current === undefined || !newest || newest === seen.current) {
      seen.current = newest;
      return;
    }
    seen.current = newest;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 1600);
    return () => clearTimeout(t);
  }, [loaded, newest]);
  const on = !!view?.on;
  const set = (value: boolean) =>
    void act.run(async () => {
      await post(`/api/initiatives/${k}/auto-mode`, { on: value });
      setAsking(false);
      onChanged();
    });
  return (
    <span className="auto-mode">
      <span className={`auto-switch${on ? ' on' : ''}${pulse ? ' pulse' : ''}`} data-testid="auto-switch">
        <button type="button" role="switch" aria-checked={on} data-testid="auto-switch-button" disabled={act.busy || !loaded} onClick={() => (on ? set(false) : setAsking(true))}>
          <span className="auto-knob" aria-hidden="true" />
          Auto mode
        </button>
      </span>
      {asking && !on && (
        <span className="auto-confirm" data-testid="auto-confirm">
          For 24 hours, the Architect decides low-risk blockers for you. You can undo each decision in the Inbox.{' '}
          <button type="button" className="primary" data-testid="auto-confirm-on" disabled={act.busy} onClick={() => set(true)}>
            Turn on
          </button>{' '}
          <button type="button" className="link" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </span>
      )}
      {act.error && <span className="error">{act.error}</span>}
    </span>
  );
}

/**
 * "Decided for you", on the History tab: the Architect's auto decisions of the last 7 days, with Take back while it still
 * works and Approve. The ones still to review are also in the Inbox and the room's strip.
 */
function AutoDecisions({ view, onChanged }: { view: AutoView | null; onChanged: () => void }) {
  if (!view || (!view.on && view.decisions.length === 0)) return null;
  return (
    <section className="auto-decisions" data-testid="auto-decisions">
      <h3>Decided for you</h3>
      {view.decisions.length === 0 && <p className="muted">The Architect has not decided anything for you yet.</p>}
      <AutoDecisionList decisions={view.decisions} onChanged={onChanged} />
    </section>
  );
}

/** Auto decisions of the Architect with Approve and Take back. The decision text is the Architect's own, so it is plain text only. */
export function AutoDecisionList({ decisions, onChanged }: { decisions: AutoDecision[]; onChanged: () => void }) {
  const act = useAction();
  const run = (id: string, what: 'undo' | 'approve') => void act.run(async () => (await post(`/api/architect-answers/${encodeURIComponent(id)}/${what}`, {}), onChanged()));
  return (
    <ul className="answer-list">
      {decisions.map((d) => {
        const clientAnswer = (d.citation as { client_answer?: unknown } | null)?.client_answer;
        return (
          <li key={d.id} className="answer-row" data-testid="auto-decision">
            <div className="muted">
              {d.decision_kind === 'product' ? 'Product' : 'Technical'} decision on a {(d.blocker_kind ?? 'blocker').replace(/_/g, ' ')} blocker · {AUTO_STATE[d.state] ?? d.state}
              {d.state === 'held' && d.hold_until ? ` until ${fmt(d.hold_until)}` : ''} · {fmt(d.created_at)}
            </div>
            {d.question && <p data-testid="auto-question">{d.question}</p>}
            <p className="answer-text">{d.answer}</p>
            {typeof clientAnswer === 'string' ? <div className="muted cited-fact">Cited: your answer on blocker {clientAnswer}</div> : <Cited citation={d.citation} checkedAt={d.decided_at} />}
            {d.refusal && <p className="error">{d.refusal}</p>}
            <div className="answer-actions">
              {!d.reviewed_at && AUTO_TO_REVIEW.includes(d.state) && (
                <button type="button" data-testid="auto-approve" disabled={act.busy} onClick={() => run(d.id, 'approve')}>
                  Approve
                </button>
              )}
              {d.undoable && (
                <button type="button" className="link" data-testid="auto-undo" disabled={act.busy} onClick={() => run(d.id, 'undo')}>
                  Take back
                </button>
              )}
            </div>
          </li>
        );
      })}
      {act.error && <li className="error">{act.error}</li>}
    </ul>
  );
}

/**
 * The Architect's escalation of a blocker, inside that blocker's card in the Inbox: its recommendation, why the Client
 * decides, and Accept, which posts the recommendation as the Client's answer and resolves the blocker.
 */
export function ArchitectRecommends({ a, onChanged }: { a: AnswerRow; onChanged?: () => void }) {
  const act = useAction();
  const c = (a.citation ?? {}) as { why_client?: unknown; checked?: unknown };
  return (
    <div className="decision-rec architect-rec" data-testid="architect-rec">
      <h4>The Architect recommends</h4>
      <p className="answer-text">{a.answer}</p>
      {c.why_client !== undefined && (
        <p className="muted" data-testid="answer-why">
          Why you decide: {String(c.why_client)} Checked: {String(c.checked ?? '')}
        </p>
      )}
      <button
        type="button"
        className="primary"
        data-testid="answer-accept"
        disabled={act.busy}
        onClick={() => void act.run(async () => (await post(`/api/architect-answers/${encodeURIComponent(a.id)}/accept`, {}), onChanged?.()))}
      >
        Accept recommendation
      </button>
      {act.error && <p className="error">{act.error}</p>}
    </div>
  );
}

export function AnswerList({ rows, onChanged }: { rows: AnswerRow[]; onChanged: () => void }) {
  const act = useAction();
  if (rows.length === 0) return null;
  return (
    <ul className="answer-list" data-testid="answer-list">
      {rows.map((r) => {
        // An escalation is told apart by its citation, which only an escalation has ({"escalated": true}), so an accepted one
        // (posted, to be reopened) is not shown as an answer from a decision.
        const waiting = r.state === 'escalated';
        const escalation = typeof r.citation === 'object' && r.citation !== null && 'escalated' in r.citation;
        return (
          <li key={r.id} className="answer-row" data-testid="answer-row">
            <div className="muted">
              {waiting ? 'Waiting for the Client' : escalation ? 'Accepted by the Client' : 'Answered from a client decision'} · {fmt(r.created_at)}
            </div>
            {r.question && <p data-testid="answer-question">{r.question}</p>}
            <p className="answer-text">{r.answer}</p>
            {r.context && <p className="muted" data-testid="answer-context">{r.context}</p>}
            {/* An escalation has no citation of its own: its citation field only marks it as escalated. */}
            {!escalation && <Cited citation={r.citation} checkedAt={r.decided_at ?? null} />}
            {escalation && (r.citation as { why_client?: unknown }).why_client !== undefined && (
              <p className="muted" data-testid="answer-why">
                Why the Client decides: {String((r.citation as { why_client?: unknown }).why_client)} Checked: {String((r.citation as { checked?: unknown }).checked ?? '')}
              </p>
            )}
            {r.refusal && <p className="error">{r.refusal}</p>}
            <div className="answer-actions">
              {waiting && (
                <button
                  type="button"
                  data-testid="answer-accept"
                  disabled={act.busy}
                  onClick={() => void act.run(async () => (await post(`/api/architect-answers/${encodeURIComponent(r.id)}/accept`, {}), onChanged()))}
                >
                  Accept recommendation
                </button>
              )}
              {!waiting && (
                <button
                  type="button"
                  data-testid="answer-approve"
                  disabled={act.busy}
                  onClick={() => void act.run(async () => (await post(`/api/architect-answers/${encodeURIComponent(r.id)}/approve`, {}), onChanged()))}
                >
                  Approve
                </button>
              )}
              {!waiting && (
                <button
                  type="button"
                  className="link"
                  data-testid="answer-reopen"
                  disabled={act.busy}
                  onClick={() => void act.run(async () => (await post(`/api/architect-answers/${encodeURIComponent(r.id)}/reopen`, {}), onChanged()))}
                >
                  Take back
                </button>
              )}
            </div>
          </li>
        );
      })}
      {act.error && <li className="error">{act.error}</li>}
    </ul>
  );
}

/** A research job linked to this initiative, with its report versions, as the Research tab lists it. */
type ReportRow = { job_id: string; title: string | null; status: string; repo_path: string; linked_at?: string; created_at?: string; versions?: { version: number; summary: string; created_at: string }[] };

/**
 * The Research tab (phase 5, criterion 1): the research reports linked to this initiative with their versions, and the
 * research jobs of its repositories that can be linked. A link or an unlink is a Client action. Titles and summaries are
 * text from agents and the Client: shown as plain text only.
 */
function ResearchTab({ k, version, onChanged }: { k: string; version: number; onChanged: () => void }) {
  const act = useAction();
  const { data, error, reload } = useData<{ linked: ReportRow[]; candidates: ReportRow[] }>(`/api/initiatives/${k}/reports`, version);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading...</p>;
  const changed = () => {
    reload();
    onChanged();
  };
  return (
    <div className="research-tab" data-testid="research-tab">
      <h3>Linked reports</h3>
      {data.linked.length === 0 && <p className="muted">No research report is linked to this project. The Architect reads only linked reports.</p>}
      <ul className="report-list" data-testid="report-list">
        {data.linked.map((r) => (
          <li key={r.job_id} data-testid="linked-report">
            <div>
              <strong>{r.title || r.job_id}</strong> <span className="muted">({r.status})</span>
            </div>
            <div className="muted">
              <code>{r.job_id}</code>
            </div>
            <ul>
              {(r.versions ?? []).map((v) => (
                <li key={v.version} data-testid="linked-report-version">
                  v{v.version}: {v.summary} <span className="muted">{fmt(v.created_at)}</span>
                </li>
              ))}
              {(r.versions ?? []).length === 0 && <li className="muted">No version yet.</li>}
            </ul>
            <button
              type="button"
              className="link"
              data-testid="unlink-report"
              disabled={act.busy}
              onClick={() => act.run(async () => (await post(`/api/initiatives/${k}/reports/${encodeURIComponent(r.job_id)}`, {}, 'DELETE'), changed()))}
            >
              Unlink
            </button>
          </li>
        ))}
      </ul>
      <h3>Research jobs that can be linked</h3>
      {data.candidates.length === 0 && <p className="muted">No unlinked research job is on this project's repositories.</p>}
      <ul className="report-list" data-testid="candidate-report-list">
        {data.candidates.map((r) => (
          <li key={r.job_id} data-testid="candidate-report">
            <strong>{r.title || r.job_id}</strong> <span className="muted">({r.status})</span>{' '}
            <button type="button" data-testid="link-report" disabled={act.busy} onClick={() => act.run(async () => (await post(`/api/initiatives/${k}/reports`, { job_id: r.job_id }), changed()))}>
              Link
            </button>
          </li>
        ))}
      </ul>
      {act.error && <p className="error">{act.error}</p>}
    </div>
  );
}

/** How wide the Architect pane is: a rail of icons, a side column, or a wide column for a conversation. */
export type ArchitectWidth = 'rail' | 'side' | 'wide';
const WIDTHS: [ArchitectWidth, string][] = [
  ['rail', 'Rail'],
  ['side', 'Side'],
  ['wide', 'Wide'],
];
/** The browser keeps the Client's choice under this key. Without a stored choice the pane starts as a rail. */
const WIDTH_KEY = 'triglav.architect-width';
function storedWidth(): ArchitectWidth {
  try {
    const w = localStorage.getItem(WIDTH_KEY);
    return w === 'side' || w === 'wide' ? w : 'rail';
  } catch {
    return 'rail';
  }
}

/**
 * The Architect of the initiative: its chat, started on the first message. As a rail it shows only its buttons and a dot
 * when a message or a Confirm card arrived since the pane was last open. The chat stays loaded in every width, so the dot
 * and the room's reload on a card work while it is folded.
 */
function ArchitectPane({ chatId, width, pane, onWidth, onDecided, chips, onRemove, onSent, blocks }: { chatId: string; width: ArchitectWidth; pane: 'design' | 'architect'; onWidth: (w: ArchitectWidth) => void; onDecided: () => void; chips: Chip[]; onRemove: (n: number) => void; onSent: (sent: Chip[]) => void; blocks: BlockLinks }) {
  const chat = useChat(chatId, ARCHITECT_CHATS);
  // What the Client has seen: the chat as first loaded, then everything up to the last time the pane was open. Only a
  // message or a card that arrives after that lights the rail's dot.
  const activity = chat.messages.length + Object.keys(chat.actions).length;
  const [seen, setSeen] = useState<number | null>(null);
  useEffect(() => {
    if (chat.loaded && (seen === null || width !== 'rail')) setSeen(activity);
  }, [chat.loaded, width, activity]);
  const unseen = width === 'rail' && seen !== null && activity > seen;
  // The composer's send: the pending Quote chips ride along, and they are cleared once sent.
  const send = async (t: string, images: { data: string }[]) => {
    const r = await post(`${ARCHITECT_CHATS}/${chatId}/messages`, {
      text: t,
      refs: chips.map(({ block, field, version, text }) => ({ block, field, version, ...(text ? { text } : {}) })),
      ...(images.length ? { images } : {}),
    });
    onSent(chips);
    return r;
  };
  // A suggested reply is sent as its own text: no Quote chip is attached, and the chips stay for the composer.
  const reply = (t: string) => post(`${ARCHITECT_CHATS}/${chatId}/messages`, { text: t, refs: [] });
  // A card arriving or changing state is a chat event, not a Triglav event, so the room reads the design again itself.
  const cards = Object.values(chat.actions)
    .map((a) => `${a.id}:${a.state}`)
    .sort()
    .join(',');
  useEffect(() => {
    if (cards) onDecided();
  }, [cards]);
  return (
    <div className={`architect-pane width-${width}`} data-testid="architect-pane" data-width={width}>
      <div className="architect-rail" data-testid="architect-rail">
        <button type="button" className="rail-button" aria-label="Open the Architect" title="Open the Architect (\)" data-testid="architect-open" onClick={() => onWidth('side')}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
        <button type="button" className="rail-button" aria-label={unseen ? 'The Architect: new messages' : 'The Architect'} data-testid="architect-rail-chat" data-seen-set={seen !== null} onClick={() => onWidth('side')}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          {unseen && <span className="rail-dot" data-testid="architect-unseen" />}
        </button>
        <span className="rail-label">Architect{chat.state === 'working' ? ' · working' : ''}</span>
      </div>
      <div className="architect-body">
        <div className="architect-head">
          <strong>Architect</strong>
          <div className="width-switch" role="group" aria-label="Pane width">
            {WIDTHS.map(([w, label]) => (
              <button key={w} type="button" aria-pressed={width === w} data-testid={`architect-width-${w}`} onClick={() => onWidth(w)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="muted architect-note">The Architect reads this design and the code at origin. A change it proposes waits for your Confirm.</p>
        <ChatLog chatId={chatId} chat={chat} who="The Architect" onDecided={onDecided} reply={reply} blocks={blocks} showKey={`${width}:${pane}`} empty={<p className="muted chat-empty">Ask the Architect about the design, or tell it what changed.</p>} />
      {chips.length > 0 && (
        <ul className="quote-chips" data-testid="quote-chips" aria-label="References">
          {chips.map((c, n) => (
            <li key={`${c.block}.${c.field}.${c.version}.${n}`} className="quote-chip">
              <span>
                {c.block}.{c.field} v{c.version}
                {c.text && <span className="muted"> "{c.text.length > 60 ? `${c.text.slice(0, 60)}...` : c.text}"</span>}
              </span>
              <button type="button" aria-label={`Remove ${c.block}.${c.field} v${c.version}`} onClick={() => onRemove(n)}>
                x
              </button>
            </li>
          ))}
        </ul>
      )}
        <ChatComposer chatId={chatId} base={ARCHITECT_CHATS} working={chat.state === 'working'} placeholder="Ask the Architect" images send={send} />
      </div>
    </div>
  );
}

/** The room of one initiative. On a phone, one pane at a time with a toggle. */
/** A tab of the room, and the block it opens to. */
export type RoomOpen = (tab: RoomTab, target?: string) => void;
type RoomTab = 'design' | 'plan' | 'research' | 'history';
const ROOM_TABS: RoomTab[] = ['design', 'plan', 'research', 'history'];

/**
 * An initiative's room. at is the rest of the route: #/initiatives/<key>/plan/<card> opens the Plan tab on that card, and
 * #/initiatives/<key>/history the History tab, so the Inbox can link to the item it lists. inbox draws the strip of what
 * waits for the Client in this initiative (App.tsx), with open to go to the tab an item lives on. It reloads with the room,
 * so a design change the Architect proposes in the chat (a chat event, not a Triglav one) shows in it at once.
 */
export function InitiativePage({ k, version, at = [], inbox }: { k: string; version: number; at?: string[]; inbox?: (open: RoomOpen, version: number) => ReactNode }) {
  const [tab, setTab] = useState<RoomTab>('design');
  const [pane, setPane] = useState<'design' | 'architect'>('design');
  const [shown, setShown] = useState<number | null>(null);
  const [nudge, setNudge] = useState(0);
  const [chips, setChips] = useState<Chip[]>([]);
  // A block name clicked in the chat: its tab and the design pane open, and that tab shows the block (DesignTab opens its
  // row, PlanTab picks the card or shows the wave) and clears the target.
  const [target, setTarget] = useState<string | null>(null);
  const [width, setWidthState] = useState<ArchitectWidth>(storedWidth);
  // The width the \ key opens a rail to: the last open width.
  const lastOpen = useRef<ArchitectWidth>(width === 'rail' ? 'side' : width);
  const setWidth = (w: ArchitectWidth) => {
    if (w !== 'rail') lastOpen.current = w;
    setWidthState(w);
    try {
      localStorage.setItem(WIDTH_KEY, w);
    } catch {
      // A browser without storage keeps the width for this page only.
    }
  };
  // The key handler is armed once, so it reads the width and the setter through a ref.
  const widthRef = useRef({ width, setWidth });
  widthRef.current = { width, setWidth };
  // The \ key folds the Architect to a rail, or opens it again, unless the Client is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '\\' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      e.preventDefault();
      const { width: w, setWidth: set } = widthRef.current;
      set(w === 'rail' ? lastOpen.current : 'rail');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const { data, error, reload } = useData<Json>(`/api/initiatives/${k}${shown ? `?version=${shown}` : ''}`, version + nudge);
  // The current version's cards and their merged checks (the Design tab reads the PR and the date from them).
  const jobs = useData<Json>(`/api/initiatives/${k}/jobs`, version + nudge);
  // A merged check is recorded without an event, so the Design tab's merge lines are read again every 30 s.
  const reloadJobs = jobs.reload;
  useEffect(() => {
    const t = setInterval(reloadJobs, 30_000);
    return () => clearInterval(t);
  }, [reloadJobs]);
  useEffect(() => setShown(null), [k]);
  // A link from the Inbox (or a reload of one) opens its tab and block; a later click on a tab does not change the route.
  const atKey = at.join('/');
  useEffect(() => {
    const [t, id] = atKey.split('/');
    if (!ROOM_TABS.includes(t as RoomTab)) return;
    open(t as RoomTab, id || undefined);
  }, [atKey]);
  // Auto mode and the Architect's auto decisions. A decision, a post after its hold and a switch each write an event, so the
  // live version reloads it.
  const auto = useData<AutoView>(`/api/initiatives/${k}/auto-mode`, version + nudge);
  function open(t: RoomTab, id?: string) {
    setTab(t);
    setPane('design');
    if (id) setTarget(id);
  }
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading...</p>;
  const i = data.initiative;
  // An initiative started from a research report keeps the job and version in its first version's trigger (<job>@v<version>).
  const first = (data.versions as Json[]).find((v) => v.version === 1);
  const ref = first?.trigger_kind === 'research' ? /^(.+)@v(\d+)$/.exec(String(first.trigger_ref ?? '')) : null;
  const origin = ref ? { job: ref[1], version: Number(ref[2]) } : null;
  const autoView = auto.data ?? null;
  const autoChanged = () => {
    setNudge((n) => n + 1);
    reload();
  };
  const merged: Record<string, Merged[]> = shown ? Object.create(null) : mergedGatesOf((jobs.data?.cards ?? []) as Json[]);
  const sources: Record<string, Merged[]> = shown ? Object.create(null) : mergedSourcesOf((jobs.data?.cards ?? []) as Json[]);
  // A chip names the version on screen, so a quote of an older version says which one it came from.
  // A quote opens a folded Architect, so the chip is in view above the message box.
  const quote = {
    version: data.version.version as number,
    add: (c: ChipInput) => {
      if (width === 'rail') setWidth(lastOpen.current);
      setChips((list) => (list.length < MAX_CHIPS ? [...list, { ...c, version: data.version.version }] : list));
    },
  };
  return (
    <QuoteContext.Provider value={quote}>
      <MergedContext.Provider value={merged}>
        <SourceMergeContext.Provider value={sources}>
          <div className={`room show-${pane}`} data-testid="room">
            <div className="room-head">
              <div>
                <h2>{i.title}</h2>
                <span className="muted">
                  {i.key} · {i.repos.map((r: Json) => r.slug).join(', ')}
                  {origin && (
                    <>
                      {' '}
                      · <a href={`#/jobs/${origin.job}`} data-testid="room-from-report">from version {origin.version} of a research report</a>
                    </>
                  )}
                </span>
              </div>
              <label className="room-version">
                Version{' '}
                <select aria-label="Version" data-testid="room-version" value={data.version.version} onChange={(e) => setShown(Number(e.target.value) === i.current_version ? null : Number(e.target.value))}>
                  {(data.versions as Json[]).map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version}
                      {v.version === i.current_version ? ' (current)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              {/* A plain link: the session cookie goes with it, and the server sends the file as an attachment. */}
              <a className="link" data-testid="download-markdown" href={`/api/initiatives/${k}/versions/${data.version.version}/markdown`}>
                Download as markdown
              </a>
              <AutoModeSwitch k={k} view={autoView} onChanged={autoChanged} />
            </div>
            {autoView?.on && (
              <p className="auto-banner" data-testid="auto-banner">
                Auto mode: the Architect decides low-risk blockers for you until {fmt(autoView.until ?? '')}. Anything that changes scope, data, security, billing or what users see still comes to you.
              </p>
            )}
            <nav className="room-panes" aria-label="Pane">
              <button type="button" aria-pressed={pane === 'design'} data-testid="pane-design" onClick={() => setPane('design')}>
                Design
              </button>
              <button type="button" aria-pressed={pane === 'architect'} data-testid="pane-architect" onClick={() => setPane('architect')}>
                Architect
              </button>
            </nav>
            <div className={`room-body arch-${i.chat_id ? width : 'none'}`}>
              <div className="room-main">
                {inbox?.(open, version + nudge)}
                <nav className="subtabs" aria-label="Room">
                  <a href={`#/initiatives/${k}`} aria-current={tab === 'design' ? 'page' : undefined} data-testid="tab-design" onClick={(e) => (e.preventDefault(), setTab('design'))}>
                    Design v{data.version.version}
                  </a>
                  <a href={`#/initiatives/${k}`} aria-current={tab === 'plan' ? 'page' : undefined} data-testid="tab-plan" onClick={(e) => (e.preventDefault(), setTab('plan'))}>
                    Plan
                  </a>
                  <a href={`#/initiatives/${k}`} aria-current={tab === 'history' ? 'page' : undefined} data-testid="tab-history" onClick={(e) => (e.preventDefault(), setTab('history'))}>
                    History
                  </a>
                  <a href={`#/initiatives/${k}`} aria-current={tab === 'research' ? 'page' : undefined} data-testid="tab-research" onClick={(e) => (e.preventDefault(), setTab('research'))}>
                    Research
                  </a>
                </nav>
                {tab === 'design' && <DesignTab data={data} onPlan={() => setTab('plan')} target={target} onShown={() => setTarget(null)} />}
                {tab === 'plan' && (
                  <PlanTab
                    k={k}
                    data={data}
                    current={data.version.version === i.current_version}
                    target={target}
                    onShown={() => setTarget(null)}
                    version={version + nudge}
                    onChanged={() => {
                      setNudge((n) => n + 1);
                      reload();
                    }}
                  />
                )}
                {tab === 'research' && (
                  <ResearchTab
                    k={k}
                    version={version + nudge}
                    onChanged={() => {
                      setNudge((n) => n + 1);
                      reload();
                    }}
                  />
                )}
                {tab === 'history' && (
                  <>
                    <HistoryTab data={data} />
                    <AutoDecisions view={autoView} onChanged={autoChanged} />
                  </>
                )}
              </div>
              {i.chat_id && (
                <ArchitectPane
                  chatId={i.chat_id}
                  blocks={{
                    ids: new Set((data.version.doc.blocks as Json[]).map((b) => b.id as string)),
                    show: (id) => {
                      const kind = (data.version.doc.blocks as Json[]).find((b) => b.id === id)?.kind;
                      setTab(kind === 'card' || kind === 'wave' ? 'plan' : 'design');
                      setPane('design');
                      setTarget(id);
                    },
                  }}
                  width={width}
                  pane={pane}
                  onWidth={setWidth}
                  chips={chips}
                  onRemove={(n) => setChips((list) => list.filter((_, idx) => idx !== n))}
                  onSent={(sent) => setChips((list) => list.filter((c) => !sent.includes(c)))}
                  onDecided={() => {
                    setNudge((n) => n + 1);
                    reload();
                  }}
                />
              )}
            </div>
          </div>
        </SourceMergeContext.Provider>
      </MergedContext.Provider>
    </QuoteContext.Provider>
  );
}
