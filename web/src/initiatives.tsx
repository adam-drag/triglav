// Initiatives (docs/plans/initiative-room.md): the list, and the room of one initiative with its versioned design, its
// history and the Architect chat. Block text and the Architect's replies are rendered with the safe markdown renderer
// (no raw HTML, no images, only http(s) and in-app links).
import { useEffect, useState, type ReactNode } from 'react';
import { fmt, get, post, useData, type Json } from './api.ts';
import { ChatComposer, ChatLog, markdown, useAction, useChat } from './chat.tsx';

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
  if (g.kind === 'milestone') return `milestone ${g.ref} open`;
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
      {diff?.blocks.map((b: Json) => (
        <div key={b.id} className="diff-block">
          <strong>
            {b.change} {b.id}
          </strong>{' '}
          {b.title}
          {(b.fields as Json[]).map((f) => (
            <div key={f.field} className="diff-field">
              <span className="muted">{f.field}</span>
              {f.before != null && <pre className="diff-before">{typeof f.before === 'string' ? f.before : JSON.stringify(f.before, null, 1)}</pre>}
              {f.after != null && <pre className="diff-after">{typeof f.after === 'string' ? f.after : JSON.stringify(f.after, null, 1)}</pre>}
            </div>
          ))}
        </div>
      ))}
    </details>
  );
}

function HistoryTab({ data }: { data: Json }) {
  return (
    <div className="history" data-testid="history">
      {(data.versions as Json[]).map((v) => (
        <VersionRow key={v.version} k={data.initiative.key} v={v} />
      ))}
    </div>
  );
}

/** The Architect of the initiative: its chat, started on the first message. */
function ArchitectPane({ chatId, onDecided }: { chatId: string; onDecided: () => void }) {
  const chat = useChat(chatId);
  return (
    <div className="architect-pane" data-testid="architect-pane">
      <p className="muted architect-note">The Architect reads this design and the code at origin. A change it proposes waits for your Confirm.</p>
      <ChatLog chatId={chatId} chat={chat} who="The Architect" onDecided={onDecided} empty={<p className="muted chat-empty">Ask the Architect about the design, or tell it what changed.</p>} />
      <ChatComposer chatId={chatId} working={chat.state === 'working'} placeholder="Ask the Architect" send={(t) => post(`/api/chats/${chatId}/messages`, { text: t })} />
    </div>
  );
}

/** The room of one initiative. On a phone, one pane at a time with a toggle. */
export function InitiativePage({ k, version }: { k: string; version: number }) {
  const [tab, setTab] = useState<'design' | 'history'>('design');
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
        {pending > 0 && <span className="pill status-waiting">{pending} change waiting for you</span>}
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
            <a href={`#/initiatives/${k}`} aria-current={tab === 'history' ? 'page' : undefined} data-testid="tab-history" onClick={(e) => (e.preventDefault(), setTab('history'))}>
              History
            </a>
          </nav>
          {tab === 'design' ? <DesignTab data={data} /> : <HistoryTab data={data} />}
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
