// Initiatives (docs/plans/initiative-room.md): the list, and the room of one initiative with its versioned design, its
// history and the Architect chat. Block text and the Architect's replies are rendered with the safe markdown renderer
// (no raw HTML, no images, only http(s) and in-app links).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fmt, get, post, useData, type Json } from './api.ts';
import { ARCHITECT_CHATS, ChatComposer, ChatLog, markdown, useAction, useChat } from './chat.tsx';

const md = (s: string) => ({ __html: markdown.parse(s, { async: false }) as string });
const inline = (s: string) => ({ __html: markdown.parseInline(s, { async: false }) as string });

/** The initiatives, and the import form for a new one. */
export function InitiativesPage({ version }: { version: number }) {
  const list = useData<Json[]>('/api/initiatives', version);
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
      </div>
      {children}
    </div>
  );
}

function BlockBody({ b, byId, updatedIn }: { b: Json; byId: Map<string, Json>; updatedIn: Record<string, number> }) {
  if (b.kind === 'text' || b.kind === 'decision' || b.kind === 'contract')
    return (
      <>
        <div className="block-body" dangerouslySetInnerHTML={md(b.body)} />
        {b.superseded_by && <p className="muted">Superseded by {b.superseded_by}</p>}
      </>
    );
  if (b.kind === 'open')
    return (
      <>
        {b.closed && <p className="block-closed">Closed: {b.closed}</p>}
        <div className="block-body" dangerouslySetInnerHTML={md(b.body)} />
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
  // A job card.
  return (
    <details className="design-card">
      <summary>
        <span className="pill">{b.repo}</span> {b.size && <span className="pill">{b.size}</span>} {b.milestone && <span className="pill">milestone {b.milestone}</span>}{' '}
        {b.pr && (
          <a href={b.pr} target="_blank" rel="noreferrer">
            PR
          </a>
        )}{' '}
        {b.merged && <span className="muted">merged {b.merged}</span>}
        {b.gates?.length > 0 && <span className="muted"> Gates: {(b.gates as Json[]).map(gateText).join('; ')}</span>}
      </summary>
      {b.note && <p className="muted">{b.note}</p>}
      {b.deps?.length > 0 && <p className="muted">After: {b.deps.join(', ')}</p>}
      {b.decisions?.length > 0 && <p className="muted">Decisions: {b.decisions.join(', ')}</p>}
      <div className="block-body" dangerouslySetInnerHTML={md(b.goal)} />
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

function DesignTab({ data }: { data: Json }) {
  const blocks: Json[] = data.version.doc.blocks;
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const updatedIn: Record<string, number> = data.updated_in;
  const inWave = new Set(blocks.filter((b) => b.kind === 'wave').flatMap((w) => w.jobs as string[]));
  return (
    <div className="design" data-testid="design">
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
  return (
    <details
      className="history-row pending-revision"
      data-testid="pending-revision"
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open && !view)
          get<Json>(`/api/initiatives/${k}/revisions/${r.id}`)
            .then(setView)
            .catch((x) => setError((x as Error).message));
      }}
    >
      <summary>
        <strong>Waiting for you</strong> <span className="muted">on v{r.base_version}</span>
        <div>{r.summary}</div>
        <div className="muted">Confirm or deny it on its card in the Architect chat.</div>
      </summary>
      {error && <p className="error">{error}</p>}
      {view && <DiffBlocks blocks={view.blocks} />}
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
      {(data.versions as Json[]).map((v) => (
        <VersionRow key={v.version} k={data.initiative.key} v={v} />
      ))}
    </div>
  );
}

type Preview = { can_start: boolean; state: string; reasons: string[]; prompt: string | null; started_from_version: number; repo: Json; warning: string | null };

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
  // A merged check lands in the scheduler, which does not announce it to the room, so the tab reads again every 30 s. The
  // interval is armed once; the latest reload is read through a ref, since reload changes on every render.
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
  useEffect(() => {
    const t = window.setInterval(() => reloadRef.current(), 30_000);
    return () => window.clearInterval(t);
  }, []);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading...</p>;
  const over = data.running >= data.cap;
  // Each milestone a gate waits for, once: the Client starts it here. The server lists the started ones.
  const started: string[] = data.milestones_open ?? [];
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

function CardRow({ k, c, onChanged }: { k: string; c: Json; onChanged: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [markKey, setMarkKey] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [started, setStarted] = useState<string | null>(null);
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
      {c.state === 'locked' && <p className="muted">{c.open} open {c.open === 1 ? 'gate' : 'gates'} before this card can start.</p>}
      {started && <p className="muted" data-testid="job-started">{started}</p>}
      {c.state === 'ready' && !preview && (
        <button type="button" data-testid="card-start" onClick={openStart} disabled={act.busy}>
          Start
        </button>
      )}
      {preview && (
        <div className="start-confirm" data-testid="start-confirm">
          {preview.warning && <p className="warn-note">{preview.warning}</p>}
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
                <button type="button" data-testid="start-confirm-button" onClick={() => startJob(preview.started_from_version)} disabled={act.busy}>
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

/** The Architect of the initiative: its chat, started on the first message. */
function ArchitectPane({ chatId, onDecided }: { chatId: string; onDecided: () => void }) {
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
      <ChatComposer chatId={chatId} base={ARCHITECT_CHATS} working={chat.state === 'working'} placeholder="Ask the Architect" send={(t) => post(`${ARCHITECT_CHATS}/${chatId}/messages`, { text: t })} />
    </div>
  );
}

/** The room of one initiative. On a phone, one pane at a time with a toggle. */
export function InitiativePage({ k, version }: { k: string; version: number }) {
  const [tab, setTab] = useState<'design' | 'jobs' | 'history'>('design');
  const [pane, setPane] = useState<'design' | 'architect'>('design');
  const [shown, setShown] = useState<number | null>(null);
  const [nudge, setNudge] = useState(0);
  const { data, error, reload } = useData<Json>(`/api/initiatives/${k}${shown ? `?version=${shown}` : ''}`, version + nudge);
  useEffect(() => setShown(null), [k]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading...</p>;
  const i = data.initiative;
  const pending = (data.revisions as Json[]).filter((r) => r.state === 'pending').length;
  return (
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
          {tab === 'history' && <HistoryTab data={data} />}
        </div>
        {i.chat_id && (
          <ArchitectPane
            chatId={i.chat_id}
            onDecided={() => {
              setNudge((n) => n + 1);
              reload();
            }}
          />
        )}
      </div>
    </div>
  );
}
