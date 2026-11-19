// Initiatives (docs/plans/initiative-room.md): the list, and the room of one initiative with its versioned design, its
// history and the Architect chat. Block text and the Architect's replies are rendered with the safe markdown renderer
// (no raw HTML, no images, only http(s) and in-app links).
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { fmt, get, post, useData, type Json } from './api.ts';
import { ARCHITECT_CHATS, ChatComposer, ChatLog, markdown, useAction, useChat } from './chat.tsx';
import { citedLine, MAX_QUOTE, mergedGatesOf, mergedSourcesOf, popoverAt, quotableIn, quotableWhole, stepParts } from './initiative-view.ts';

const md = (s: string) => ({ __html: markdown.parse(s, { async: false }) as string });
const inline = (s: string) => ({ __html: markdown.parseInline(s, { async: false }) as string });

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

/** The initiatives, and the import form for a new one. */
export function InitiativesPage({ version }: { version: number }) {
  const list = useData<Json[]>('/api/initiatives', version);
  const inbox = useData<AnswerRow[]>('/api/architect-answers', version);
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
        <h3>Initiatives</h3>
      </div>
      <p className="muted">A design shared by several jobs and repositories, with an Architect who keeps it. Open one to read its design, its history and talk with its Architect.</p>
      <h2>Inbox</h2>
      {inbox.error && <p className="error">{inbox.error}</p>}
      {inbox.data && <AnswerList rows={inbox.data} onChanged={inbox.reload} />}
      {list.error && <p className="error">{list.error}</p>}
      {list.data && list.data.length === 0 && <p className="muted">No initiatives yet. Import one below.</p>}
      {list.data && list.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Initiative</th>
              <th>Version</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((i) => (
              <tr key={i.id} data-testid="initiative-row">
                <td>
                  <a href={`#/initiatives/${i.key}`}>{i.title}</a>
                  <div className="muted">{i.key}</div>
                </td>
                <td>v{i.current_version}</td>
                <td>{i.status}</td>
                <td>{fmt(i.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <details className="initiative-import">
        <summary>Import an initiative</summary>
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

const KIND_TITLES: [string, string][] = [
  ['text', 'Overview'],
  ['decision', 'Decisions'],
  ['open', 'Open decisions'],
  ['contract', 'Contracts'],
  ['wave', 'Waves and job cards'],
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

/** One block, with its id and, when it changed after the first version, the version it last changed in. */
function Block({ b, updated, children }: { b: Json; updated: number | undefined; children: ReactNode }) {
  const quote = useContext(QuoteContext);
  const field = quoteField(b);
  return (
    <div className={`design-block kind-${b.kind}${updated ? ' updated' : ''}`} id={`block-${b.id}`} data-testid="design-block" data-id={b.id}>
      <div className="design-block-head">
        <span className="block-id">{b.id}</span>
        {b.title && <strong>{b.title}</strong>}
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
      {children}
    </div>
  );
}

function BlockBody({ b, byId, updatedIn }: { b: Json; byId: Map<string, Json>; updatedIn: Record<string, number> }) {
  // Hooks come before any return below.
  const checks = useContext(MergedContext)[b.id] ?? [];
  const sourced = useContext(SourceMergeContext)[b.id] ?? [];
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
  if (b.kind === 'checkpoint' || b.kind === 'dod') return <Items items={b.kind === 'checkpoint' ? b.steps : b.items} />;
  if (b.kind === 'wave')
    return (
      <>
        <p className="muted">{b.when}</p>
        {(b.jobs as string[]).map((j) => {
          const c = byId.get(j);
          return c ? (
            <Block key={j} b={c} updated={updatedIn[j]}>
              <BlockBody b={c} byId={byId} updatedIn={updatedIn} />
            </Block>
          ) : null;
        })}
        {b.checkpoint && <p className="muted">Then Client checkpoint {b.checkpoint}.</p>}
      </>
    );
  // A job card's own PR and merge day come from the design only. A merged check of a gate this card waits for is shown on
  // its own line, with the card whose merge it is: that PR is not this card's PR. The card whose own job merged shows the
  // PR and date that a check stored in the gate evidence of its merge (sourced), because the check writes nothing into the card.
  const pr = b.pr ?? null;
  return (
    <details className="design-card">
      <summary>
        <span className="pill">{b.repo}</span> {b.size && <span className="pill">{b.size}</span>} {b.milestone && <span className="pill">milestone {b.milestone}</span>}{' '}
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
      </summary>
      {b.note && <p className="muted">{b.note}</p>}
      {b.deps?.length > 0 && <p className="muted">After: {b.deps.join(', ')}</p>}
      {b.decisions?.length > 0 && <p className="muted">Decisions: {b.decisions.join(', ')}</p>}
      {b.contracts?.length > 0 && <p className="muted">Contracts: {b.contracts.join(', ')}</p>}
      {b.delivered && <p className="muted">Recorded as delivered{b.delivered.pr ? `: ${b.delivered.pr}` : ''}{b.delivered.note ? ` (${b.delivered.note})` : ''}</p>}
      <div className="block-body" data-block={b.id} data-field="goal" dangerouslySetInnerHTML={md(b.goal)} />
      {CARD_LISTS.map(([k, label]) =>
        b[k]?.length ? (
          <div key={k}>
            <h5>{label}</h5>
            <Items items={b[k]} />
          </div>
        ) : null,
      )}
    </details>
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

function DesignTab({ data }: { data: Json }) {
  const blocks: Json[] = data.version.doc.blocks;
  const byId = new Map(blocks.map((b) => [b.id, b]));
  // A card key is data: a copy without a prototype, so a key such as `constructor` reads no inherited member.
  const updatedIn: Record<string, number> = Object.assign(Object.create(null), data.updated_in);
  const inWave = new Set(blocks.filter((b) => b.kind === 'wave').flatMap((w) => w.jobs as string[]));
  return (
    <div className="design" data-testid="design">
      <SelectionQuote byId={byId} />
      {KIND_TITLES.map(([kind, title]) => {
        const shown = blocks.filter((b) => b.kind === kind);
        if (kind === 'wave') shown.push(...blocks.filter((b) => b.kind === 'card' && !inWave.has(b.id)));
        if (!shown.length) return null;
        return (
          <div key={kind} className="design-section">
            <h4>{title}</h4>
            {shown.map((b) => (
              <Block key={b.id} b={b} updated={updatedIn[b.id]}>
                <BlockBody b={b} byId={byId} updatedIn={updatedIn} />
              </Block>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const TRIGGER: Record<string, string> = { import: 'Imported', chat: 'Confirmed in the room' };

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
    if (overlap.likely_truncated) return <p className="muted" data-testid="overlap-card-cut">The card's text is too long to check for file paths, so its overlap with the running jobs of this initiative cannot be checked.</p>;
    return <p className="muted" data-testid="overlap-none">This card names no file paths, so its overlap with the running jobs of this initiative cannot be checked.</p>;
  }
  return (
    <div data-testid="overlap">
      {overlap.likely_truncated && <p className="muted" data-testid="overlap-card-cut">The card's list of file paths was cut: the check reads at most 4000 characters of each field and 200 paths. A file the card names after the cut is not checked.</p>}
      {overlap.warnings.length > 0 && <p className="muted">This is a warning. Start still works.</p>}
      {overlap.warnings.map((w) => (
        <div className="warn-note" key={w.job_id} data-testid="overlap-warning">
          <p>
            Job {w.job_id} started from this initiative changed {w.paths.length === 1 ? 'a file this card names' : `${w.paths.length} files this card names`}, {reviewedText(w)}.
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

/** The Jobs tab: the cards of the current version by wave, with their state, gates and the Start of a ready card. */
function JobsTab({ k, version, onChanged }: { k: string; version: number; onChanged: () => void }) {
  const { data, error, reload } = useData<Json>(`/api/initiatives/${k}/jobs`, version);
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
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading...</p>;
  const over = data.running >= data.cap;
  // Each milestone a gate waits for, once: the Client starts it here. The server lists the started ones.
  const started: string[] = data.milestones_started ?? [];
  const waiting = [...new Set<string>(data.cards.flatMap((c: Json) => c.gates.filter((g: Json) => g.kind === 'milestone').map((g: Json) => String(g.key).slice('milestone:'.length))))].filter((ref) => !started.includes(ref));
  return (
    <div className="jobs" data-testid="jobs">
      {waiting.length > 0 && (
        <section className="milestones" data-testid="milestones">
          {waiting.map((ref) => (
            <MilestoneStart key={ref} k={k} milestone={ref} onChanged={() => { reload(); onChanged(); }} />
          ))}
        </section>
      )}
      <p className="muted jobs-summary" data-testid="jobs-running">
        {data.running} of {data.cap} implementation jobs from this initiative are running.
      </p>
      {over && (
        <p className="warn-note" data-testid="jobs-cap">
          The cap is reached. A Start still works, and it adds one more running job.
        </p>
      )}
      {data.waves.map((w: Json) => (
        <section key={w.id} className="jobs-wave" data-testid="jobs-wave">
          <h3>{w.title}</h3>
          {w.when && <p className="muted">{w.when}</p>}
          {data.cards
            .filter((c: Json) => c.wave === w.id)
            .map((c: Json) => (
              <CardRow
                key={c.key}
                k={k}
                c={c}
                onChanged={() => {
                  reload();
                  onChanged();
                }}
              />
            ))}
        </section>
      ))}
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

function CardRow({ k, c, onChanged }: { k: string; c: Json; onChanged: () => void }) {
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
    <article className="job-card" data-testid="job-card" data-state={c.state}>
      <div className="job-card-head">
        <span className="job-key">{c.key}</span>
        <strong>{c.title}</strong>
        <span className="pill">{c.repo}</span>
        <span className={`pill state-${c.state}`} data-testid="job-state">
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
      {c.state === 'ready' && !preview && !c.start_block && (
        <button type="button" data-testid="card-start" onClick={openStart} disabled={act.busy}>
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
type AnswerRow = { id: string; initiative_key?: string; job_id: string; answer: string; citation: Json; state: string; target: string; refusal: string | null; created_at: string; decided_at?: string | null; design_version?: number; question?: string | null; context?: string | null };

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

function AnswerList({ rows, onChanged }: { rows: AnswerRow[]; onChanged: () => void }) {
  const act = useAction();
  if (rows.length === 0) return <p className="muted">Nothing waits for the Client.</p>;
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
              {r.initiative_key ? `${r.initiative_key} · ` : ''}
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
                  className="link"
                  data-testid="answer-reopen"
                  disabled={act.busy}
                  onClick={() => void act.run(async () => (await post(`/api/architect-answers/${encodeURIComponent(r.id)}/reopen`, {}), onChanged()))}
                >
                  Reopen
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
      {data.linked.length === 0 && <p className="muted">No research report is linked to this initiative. The Architect reads only linked reports.</p>}
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
      {data.candidates.length === 0 && <p className="muted">No unlinked research job is on this initiative's repositories.</p>}
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

/** The room's Inbox: what the Client must decide for this initiative (escalations, and delegated answers Reopen can take back). The server lists only what the Client can still act on (openAnswers), so the room does not filter it again. */
function InboxTab({ k, version, onChanged }: { k: string; version: number; onChanged: () => void }) {
  const { data, error, reload } = useData<AnswerRow[]>(`/api/initiatives/${k}/inbox`, version);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading...</p>;
  return (
    <AnswerList
      rows={data}
      onChanged={() => {
        reload();
        onChanged();
      }}
    />
  );
}

/** The Architect of the initiative: its chat, started on the first message. */
function ArchitectPane({ chatId, onDecided, chips, onRemove, onSent }: { chatId: string; onDecided: () => void; chips: Chip[]; onRemove: (n: number) => void; onSent: (sent: Chip[]) => void }) {
  const chat = useChat(chatId, ARCHITECT_CHATS);
  // A card arriving or changing state is a chat event, not a Triglav event, so the room reads the design again itself.
  const cards = Object.values(chat.actions)
    .map((a) => `${a.id}:${a.state}`)
    .sort()
    .join(',');
  useEffect(() => {
    if (cards) onDecided();
  }, [cards]);
  return (
    <div className="architect-pane" data-testid="architect-pane">
      <p className="muted architect-note">The Architect reads this design and the code at origin. A change it proposes waits for your Confirm.</p>
      <ChatLog chatId={chatId} chat={chat} who="The Architect" onDecided={onDecided} empty={<p className="muted chat-empty">Ask the Architect about the design, or tell it what changed.</p>} />
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
      <ChatComposer
        chatId={chatId}
        base={ARCHITECT_CHATS}
        working={chat.state === 'working'}
        placeholder="Ask the Architect"
        send={async (t) => {
          const r = await post(`${ARCHITECT_CHATS}/${chatId}/messages`, { text: t, refs: chips.map(({ block, field, version, text }) => ({ block, field, version, ...(text ? { text } : {}) })) });
          onSent(chips);
          return r;
        }}
      />
    </div>
  );
}

/** The room of one initiative. On a phone, one pane at a time with a toggle. */
export function InitiativePage({ k, version }: { k: string; version: number }) {
  const [tab, setTab] = useState<'design' | 'jobs' | 'research' | 'history' | 'inbox'>('design');
  const [pane, setPane] = useState<'design' | 'architect'>('design');
  const [shown, setShown] = useState<number | null>(null);
  const [nudge, setNudge] = useState(0);
  const [chips, setChips] = useState<Chip[]>([]);
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
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading...</p>;
  const i = data.initiative;
  const merged: Record<string, Merged[]> = shown ? Object.create(null) : mergedGatesOf((jobs.data?.cards ?? []) as Json[]);
  const sources: Record<string, Merged[]> = shown ? Object.create(null) : mergedSourcesOf((jobs.data?.cards ?? []) as Json[]);
  const pending = (data.revisions as Json[]).filter((r) => r.state === 'pending').length;
  // A chip names the version on screen, so a quote of an older version says which one it came from.
  const quote = { version: data.version.version as number, add: (c: ChipInput) => setChips((list) => (list.length < MAX_CHIPS ? [...list, { ...c, version: data.version.version }] : list)) };
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
              {pending > 0 && (
                <button type="button" className="link" data-testid="room-pending" onClick={() => {
                    setTab('history');
                    setPane('design');
                  }}>
                  {pending === 1 ? '1 change waits for you' : `${pending} changes wait for you`}
                </button>
              )}
            </div>
            <nav className="room-panes" aria-label="Pane">
              <button type="button" aria-pressed={pane === 'design'} data-testid="pane-design" onClick={() => setPane('design')}>
                Design
              </button>
              <button type="button" aria-pressed={pane === 'architect'} data-testid="pane-architect" onClick={() => setPane('architect')}>
                Architect
              </button>
            </nav>
            <div className="room-body">
              <div className="room-main">
                <nav className="subtabs" aria-label="Room">
                  <a href={`#/initiatives/${k}`} aria-current={tab === 'design' ? 'page' : undefined} data-testid="tab-design" onClick={(e) => (e.preventDefault(), setTab('design'))}>
                    Design v{data.version.version}
                  </a>
                  <a href={`#/initiatives/${k}`} aria-current={tab === 'jobs' ? 'page' : undefined} data-testid="tab-jobs" onClick={(e) => (e.preventDefault(), setTab('jobs'))}>
                    Jobs
                  </a>
                  <a href={`#/initiatives/${k}`} aria-current={tab === 'history' ? 'page' : undefined} data-testid="tab-history" onClick={(e) => (e.preventDefault(), setTab('history'))}>
                    History
                  </a>
                  <a href={`#/initiatives/${k}`} aria-current={tab === 'research' ? 'page' : undefined} data-testid="tab-research" onClick={(e) => (e.preventDefault(), setTab('research'))}>
                    Research
                  </a>
                  <a href={`#/initiatives/${k}`} aria-current={tab === 'inbox' ? 'page' : undefined} data-testid="tab-inbox" onClick={(e) => (e.preventDefault(), setTab('inbox'))}>
                    Inbox
                  </a>
                </nav>
                {tab === 'design' && <DesignTab data={data} />}
                {tab === 'jobs' && (
                  <JobsTab
                    k={k}
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
                {tab === 'history' && <HistoryTab data={data} />}
                {tab === 'inbox' && (
                  <InboxTab
                    k={k}
                    version={version + nudge}
                    onChanged={() => {
                      setNudge((n) => n + 1);
                      reload();
                    }}
                  />
                )}
              </div>
              {i.chat_id && (
                <ArchitectPane
                  chatId={i.chat_id}
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
