import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Marked } from 'marked';
import userGuide from './user-guide.md?raw';
import { fmt, get, post, useData, useLiveVersion, type Json } from './api.ts';
import { logout } from './Login.tsx';
import { codexRoleArgs } from '../../src/codex-args.ts';
import { resumeStep } from './resume-step.ts';
import { expectedTokens } from './panel-tokens.ts';

function useRoute(): string[] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}

type Names = Map<string, { nickname: string; role: string }>;

function Who({ id, names }: { id: string | null | undefined; names: Names }) {
  if (!id) return <span className="muted">none</span>;
  if (id === 'client') return <span className="who client">Client</span>;
  if (id === 'scheduler' || id === 'linear') return <span className="who system">{id}</span>;
  const a = names.get(id);
  return (
    <span className={`who ${a?.role ?? ''}`} title={id}>
      {a ? `${a.nickname} (${a.role})` : id}
    </span>
  );
}

const Pill = ({ value, kind = 'status' }: { value: string | null | undefined; kind?: string }) => (value ? <span className={`pill ${kind}-${value}`}>{value.replaceAll('_', ' ')}</span> : null);

// Agent ids become nickname links, URLs and Linear ids become links, and `backticked` text becomes a code chip
// that copies on click, so the Client never has to select a link or a command by hand. CLI flags, ENV_NAMES and
// file references (handler.ts:941) are set in monospace even without backticks, so they stand out from the prose.
const CODE_LIKE = String.raw`(?<![\w-])--[a-z][a-z0-9-]*[a-z0-9]|\b[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]\b|(?<![\w./-])(?:[\w./-]*[\w-])?\.(?:tsx?|jsx?|mjs|json|md|py|ya?ml|sh|sql|css|html|env)(?::\d+)?(?!\w)`;
const LINKS = /agt_[0-9a-f]{16}|https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]|`[^`\n]+`|\b[A-Z][A-Z0-9]{1,9}-\d+\b/.source;
const TOKEN = new RegExp(`(${LINKS}|${CODE_LIKE})`, 'g');
const TICKET_ID = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

/** The Linear workspace and the team keys of the jobs on this dashboard, so a ticket id in a text links to its ticket. */
type Tickets = { base: string | null; teams: Set<string> };
const TicketLinks = createContext<Tickets>({ base: null, teams: new Set() });

/** The workspace comes from the ticket URLs of the jobs, so nothing about it is set by hand. */
function ticketsOf(jobs: Json[]): Tickets {
  const found: Tickets = { base: null, teams: new Set() };
  for (const j of jobs) {
    const m = /^(https:\/\/linear\.app\/[^/]+)\/issue\//.exec(j.linear_url ?? '');
    if (!m) continue;
    found.base ??= m[1];
    found.teams.add(String(j.linear_identifier).split('-')[0]);
  }
  return found;
}

/** A link to the ticket, or the plain id when its workspace is not known (it is only learned from a job). */
function TicketLink({ id }: { id: string }) {
  const { base, teams } = useContext(TicketLinks);
  return base && teams.has(id.split('-')[0]) ? <a href={`${base}/issue/${id}`} target="_blank" rel="noreferrer">{id}</a> : <>{id}</>;
}

function Rich({ text, names }: { text: string; names: Names }) {
  const parts = text.split(TOKEN);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part;
        if (part.startsWith('agt_')) {
          const a = names.get(part);
          return a ? <a key={i} href={`#/agents/${part}`} title={part}>{a.nickname}</a> : part;
        }
        if (part.startsWith('http')) return <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a>;
        if (part.startsWith('`')) return <CodeChip key={i} code={part.slice(1, -1)} />;
        if (TICKET_ID.test(part)) return <TicketLink key={i} id={part} />;
        return <code key={i} className="inline">{part}</code>;
      })}
    </>
  );
}

function CodeChip({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <code
      className="code-chip"
      role="button"
      tabIndex={0}
      title="Click to copy"
      onClick={() => void navigator.clipboard.writeText(code).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
    >
      {code}
      {copied && <span className="code-chip-copied"> copied</span>}
    </code>
  );
}

/** Long text collapsed to a few lines, with a toggle. */
function LongText({ text, names, limit = 500 }: { text: string; names: Names; limit?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > limit;
  return (
    <div className="longtext">
      <pre className={`text${long && !open ? ' clamped' : ''}`}>
        <Rich text={text} names={names} />
      </pre>
      {long && (
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

/** "5 min ago", with the exact time on hover. */
function Ago({ ts }: { ts: string | null | undefined }) {
  if (!ts) return null;
  const sec = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  const label = sec < 60 ? 'just now' : sec < 3600 ? `${Math.floor(sec / 60)} min ago` : sec < 86400 ? `${Math.floor(sec / 3600)} h ago` : fmt(ts);
  return (
    <time dateTime={ts} title={fmt(ts)}>
      {label}
    </time>
  );
}

/** A mention event repeats the message.posted event for the same message; keep one. */
function dedupeEvents(events: Json[]): Json[] {
  const posted = new Set(events.filter((e) => e.type === 'message.posted').map((e) => e.payload?.message_id));
  return events.filter((e) => !(e.type === 'mention' && posted.has(e.payload?.message_id)));
}

function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section>
      <div className="section-head">
        <h3>{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

type Tab = [key: string, text: string, href: string];

/** Pages that belong together, with the current one marked. Each tab is still its own route. */
function TabStrip({ label, tabs, current, floating = false }: { label: string; tabs: Tab[]; current: string; floating?: boolean }) {
  return (
    <nav className={`subtabs${floating ? ' floating' : ''}`} aria-label={label}>
      {tabs.map(([key, text, href]) => (
        <a key={key} href={href} aria-current={key === current ? 'page' : undefined}>
          {text}
        </a>
      ))}
    </nav>
  );
}

const AGENT_TABS: Tab[] = [
  ['agents', 'Roster', '#/agents'],
  ['research', 'Researchers', '#/research'],
];
const ACTIVITY_TABS: Tab[] = [
  ['live', 'Live map', '#/live'],
  ['activity', 'Feed', '#/activity'],
];

function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

/** Presence that matters to the Client. Active and waiting flip on every wait, so they count as one. */
const presenceClass = (p: string) => (p === 'active' || p === 'waiting' || p === 'working' || p === 'starting' ? 'online' : p);

function notify(title: string, body: string, tag: string, requireInteraction = false) {
  try {
    new Notification(title, { body, tag, requireInteraction });
  } catch {
    /* blocked or unsupported */
  }
}

/** Compares each refresh with the last one and shows a browser notification for status changes. */
function useStatusNotifications(enabled: boolean, jobs: Json[] | null, agents: Json[] | null, queue: Json[] | null, feed: Json[] | null, inbox: Json[] | null) {
  const prev = useRef<{ jobs: Map<string, string>; agents: Map<string, string>; queue: Set<string>; inbox: Set<number>; feed: number } | null>(null);
  useEffect(() => {
    if (!jobs || !agents || !queue || !feed || !inbox) return;
    const next = {
      jobs: new Map(jobs.map((j) => [j.id as string, j.status as string])),
      agents: new Map(agents.map((a) => [a.id as string, presenceClass(a.presence)])),
      queue: new Set(queue.map((b) => b.id as string)),
      inbox: new Set(inbox.map((m) => m.id as number)),
      feed: Math.max(0, ...feed.map((f) => f.id as number)),
    };
    const before = prev.current;
    prev.current = next;
    if (!before || !enabled || Notification.permission !== 'granted') return;
    for (const j of jobs) {
      const was = before.jobs.get(j.id);
      if (was !== j.status) notify(`${j.linear_identifier ?? 'Job'}: ${was ? `${was} → ` : ''}${j.status}`.replaceAll('_', ' '), j.title ?? '', `job-${j.id}`);
    }
    for (const a of agents) {
      const now = presenceClass(a.presence);
      const was = before.agents.get(a.id);
      if (was !== now) notify(`${a.nickname} (${a.role}) is ${now}`, was ? `was ${was}` : 'new agent', `agent-${a.id}`);
    }
    for (const b of queue) {
      if (!before.queue.has(b.id)) notify(`Client decision needed: ${b.linear_identifier}`, b.requested_decision ?? '', `blocker-${b.id}`);
    }
    // A message an agent tagged to the Client is rare and meant for them, so it notifies too.
    // A critical one stays on screen until dismissed, so it is not missed among routine notifications.
    for (const m of inbox) {
      if (!before.inbox.has(m.id)) {
        const critical = m.priority === 'critical';
        notify(`${critical ? '⚠ CRITICAL' : 'Message for you'}: ${m.linear_identifier ?? 'a job'}`, m.body ?? '', `inbox-${m.id}`, critical);
      }
    }
    // Pushes, PRs, comments and reviews stay in the Activity feed only: notifications are for status changes.
  }, [enabled, jobs, agents, queue, feed, inbox]);
}

function NotifyToggle({ enabled, setEnabled }: { enabled: boolean; setEnabled: (v: boolean) => void }) {
  if (typeof Notification === 'undefined') return null;
  const denied = Notification.permission === 'denied';
  const title = denied
    ? 'Notifications are blocked for this site in the browser settings'
    : enabled
      ? 'Notifications are on. Click to turn them off'
      : 'Notify me when a job or agent changes status';
  return (
    <button
      className={`notify${enabled ? ' active' : ''}`}
      data-testid="notify-toggle"
      disabled={denied}
      title={title}
      aria-label={title}
      aria-pressed={enabled}
      onClick={async () => {
        if (enabled) return setEnabled(false);
        const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
        setEnabled(perm === 'granted');
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <path d="M3.5 11.5h9l-1.2-1.8V7a3.3 3.3 0 0 0-6.6 0v2.7zM6.5 13.5h3" />
        {!enabled && <path d="M2 2l12 12" />}
      </svg>
    </button>
  );
}

const NAV: { label: string; href: string; pages: string[]; queue?: boolean }[] = [
  { label: 'Home', href: '#/', pages: ['home'] },
  { label: 'Jobs', href: '#/jobs', pages: ['jobs', 'threads'] },
  { label: 'Inbox', href: '#/queue', pages: ['queue'], queue: true },
  { label: 'Agents', href: '#/agents', pages: ['agents', 'research'] },
  { label: 'Activity', href: '#/live', pages: ['live', 'activity'] },
  { label: 'Operator', href: '#/operator', pages: ['operator'] },
  { label: 'Board', href: '#/board', pages: ['board'] },
  { label: 'Reviews', href: '#/reviews', pages: ['reviews'] },
];

const MORE: { label: string; note: string; href: string; page: string }[] = [
  { label: 'Usage', note: 'Plan limits and tokens per day', href: '#/usage', page: 'usage' },
  { label: 'Models', note: 'Model, runtime and effort per role, launch commands', href: '#/models', page: 'models' },
  { label: 'Security', note: 'Recent logins through the reverse proxy', href: '#/security', page: 'security' },
  { label: 'Guide', note: 'How to work with Triglav', href: '#/guide', page: 'guide' },
];

/** Pages the Client opens now and then. A disclosure, not an ARIA menu: a button that shows a list of plain links. */
function MoreMenu({ page }: { page: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(false), [page]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    addEventListener('mousedown', away);
    addEventListener('keydown', escape);
    return () => {
      removeEventListener('mousedown', away);
      removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div className="more" ref={box}>
      <button type="button" className={`tab more-trigger${MORE.some((m) => m.page === page) ? ' current' : ''}`} aria-expanded={open} aria-controls="more-menu" onClick={() => setOpen(!open)}>
        More
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" />
        </svg>
      </button>
      {open && (
        <ul id="more-menu" className="more-menu">
          {MORE.map((m) => (
            <li key={m.label}>
              <a href={m.href} onClick={() => setOpen(false)}>
                <span>{m.label}</span>
                <small>{m.note}</small>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function App() {
  const route = useRoute();
  const { version, connected } = useLiveVersion();
  // Presence goes stale on the clock, without an event, so refresh on a timer as well.
  const [tick, setTick] = useState(0);
  const [logoutError, setLogoutError] = useState('');
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const agents = useData<Json[]>('/api/agents?all=1', version + tick);
  const queue = useData<Json[]>('/api/queue', version);
  const inbox = useData<Json[]>('/api/inbox', version);
  const finished = useData<Json[]>('/api/finished', version);
  const jobs = useData<Json[]>('/api/jobs', version + tick);
  const tickets = useMemo(() => ticketsOf(jobs.data ?? []), [jobs.data]);
  const [notifyOn, setNotifyOn] = useState(() => {
    try {
      return localStorage.getItem('notify') === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted';
    } catch {
      return false;
    }
  });
  const setNotify = (v: boolean) => {
    setNotifyOn(v);
    try {
      localStorage.setItem('notify', v ? '1' : '0');
    } catch {
      /* storage blocked */
    }
  };
  const feedData = useData<Json[]>('/api/feed', version);
  useStatusNotifications(notifyOn, jobs.data, agents.data, queue.data, feedData.data, inbox.data);
  const names: Names = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, { nickname: a.nickname, role: a.role }])), [agents.data]);
  // A job in refinement waits for the Client on its job page, not in a blocker, so it counts here as well.
  const refining = (jobs.data ?? []).filter((j) => j.status === 'refining');
  const pending = (queue.data?.length ?? 0) + refining.length;
  // Messages tagged to the Client count apart from decisions: they need reading, not an answer.
  const unread = inbox.data?.length ?? 0;
  // Critical messages (production down, data loss, an unauthorized irreversible action) need a nav badge of their own: they must stand out on every page, not just the Inbox.
  const critical = inbox.data?.filter((m) => m.priority === 'critical').length ?? 0;
  // Finished jobs count apart too: the Client has to notice them (merge, check the result), but nothing waits on them.
  const done = finished.data?.length ?? 0;
  useEffect(() => {
    const n = pending + unread + done;
    document.title = n ? `(${n}) Triglav` : 'Triglav';
  }, [pending, unread, done]);

  const [page, id] = route;
  let body: ReactNode;
  if (page === 'jobs' && id) body = <JobPage id={id} version={version} names={names} />;
  else if (page === 'threads' && id) body = <ThreadPage id={id} version={version} names={names} />;
  else if (page === 'new') body = <NewJobPage version={version} />;
  else if (page === 'queue') body = <QueuePage version={version} names={names} refining={refining} inbox={inbox} finished={finished} focus={id} />;
  else if (page === 'agents' && id) body = <AgentPage id={id} version={version} names={names} />;
  else if (page === 'agents')
    body = (
      <>
        <TabStrip label="Agents" tabs={AGENT_TABS} current="agents" />
        <AgentsPage version={version} names={names} />
      </>
    );
  else if (page === 'models') body = <ModelsPage version={version} />;
  else if (page === 'research')
    body = (
      <>
        <TabStrip label="Agents" tabs={AGENT_TABS} current="research" />
        <ResearchPage version={version} />
      </>
    );
  else if (page === 'board') body = <BoardPage version={version} names={names} />;
  else if (page === 'reviews') body = <ReviewsPage version={version} names={names} focus={id} />;
  else if (page === 'activity')
    body = (
      <>
        <TabStrip label="Activity" tabs={ACTIVITY_TABS} current="activity" />
        <ActivityPage version={version} />
      </>
    );
  else if (page === 'live') body = <LivePage agents={agents.data ?? []} jobs={jobs.data ?? []} blockers={queue.data ?? []} version={version} />;
  else if (page === 'usage') body = <UsagePage version={version} />;
  else if (page === 'guide') body = <GuidePage />;
  else if (page === 'security') body = <SecurityPage version={version} />;
  else if (page === 'operator') body = <OperatorPage chatId={id} version={version} />;
  else if (page === 'jobs') body = <JobsPage version={version} names={names} />;
  else body = <HomePage agents={agents.data ?? []} jobs={jobs.data ?? []} queue={queue.data ?? []} refining={refining} inbox={inbox.data ?? []} finished={done} names={names} version={version} />;
  const section = page ?? 'home';

  return (
    <>
      <header>
        <a className="brand" href="#/" title="Triglav, the three-headed watcher: Staff, Senior, Researcher">
          <img src="/android-chrome-192x192.png" width="28" height="28" alt="" />
          <span>Triglav</span>
        </a>
        <nav aria-label="Main">
          {NAV.map((n) => (
            <a
              key={n.label}
              href={n.href}
              className={`tab${n.pages.includes(section) ? ' current' : ''}`}
              aria-current={n.pages.includes(section) ? 'page' : undefined}
              {...(n.queue ? { 'data-testid': 'nav-queue', 'data-count': pending, 'data-unread': unread, 'data-critical': critical, 'data-finished': done } : {})}
            >
              {n.label}
              {n.queue && critical > 0 && <span className="badge critical" title={`${plural(critical, 'critical message')} for you`}>{critical}</span>}
              {n.queue && pending > 0 && <span className="badge">{pending}</span>}
              {n.queue && done > 0 && <span className="badge done" title={`${plural(done, 'finished job')} to look at`}>{done}</span>}
              {n.queue && unread > 0 && <span className="badge soft" title={`${plural(unread, 'unread message')} for you`}>{unread}</span>}
            </a>
          ))}
          <MoreMenu page={section} />
        </nav>
        <a className="button primary" href="#/new" data-testid="header-new-job">
          New job
        </a>
        <NotifyToggle enabled={notifyOn} setEnabled={setNotify} />
        <span className={`live ${connected ? 'on' : 'off'}`} data-testid="live-status" data-connected={connected ? 'true' : 'false'}>
          <span className="dot" />
          {connected ? 'live' : 'offline'}
        </span>
        <button type="button" onClick={() => void logout().then(() => setLogoutError(''), (e: Error) => setLogoutError(`Not logged out: ${e.message}`))} data-testid="logout">
          Log out
        </button>
        {logoutError && (
          <span role="alert" className="muted" data-testid="logout-error">
            {logoutError}
          </span>
        )}
      </header>
      {page !== 'new' && <StartProblems version={version} />}
      <main className={page === 'live' ? 'home-main' : ''}>
        <TicketLinks.Provider value={tickets}>{body}</TicketLinks.Provider>
      </main>
    </>
  );
}

function JobsPage({ version, names }: { version: number; names: Names }) {
  const { data, error } = useData<Json[]>('/api/jobs', version);
  const requests = useData<Json[]>('/api/job-requests', version);
  const [needsMe, setNeedsMe] = useState(false);
  const [states, setStates] = useState<string[]>([]);
  const [sort, setSort] = useState<{ key: JobSortKey; dir: 1 | -1 } | null>(null);
  const [text, setText] = useState('');
  const [page, setPage] = useState(0);
  // A match on the ticket or the title, partial and case-insensitive, on top of the state and Needs me filters.
  const q = text.trim().toLowerCase();
  const hit = (...parts: string[]) => !q || parts.some((p) => p.toLowerCase().includes(q));
  const filtered = needsMe || states.length > 0 || q !== '';
  const clearFilters = () => {
    setNeedsMe(false);
    setStates([]);
    setText('');
    setPage(0);
  };
  // The filter groups the detailed states: "In progress" is everything that is still going on, so it includes planning and review.
  // No group ticked shows every state.
  const inGroup = (s: string) => states.length === 0 || states.includes(stateGroup(s));
  const matching = (data ?? []).filter((j) => (!needsMe || j.next_action === 'Client decision needed' || j.status === 'refining') && inGroup(j.status) && hit(j.linear_identifier ?? '', j.title ?? ''));
  // Without a sort the server's order stands: subjobs under their parent, oldest first.
  const rows = sort ? [...matching].sort((a, b) => sort.dir * compareJobs(a, b, sort.key)) : matching;
  // A click sorts ascending (Last activity: newest first), a second click reverses, a third goes back to the default order.
  const sortBy = (key: JobSortKey) => {
    setSort(sort?.key !== key ? { key, dir: key === 'last_activity' ? -1 : 1 } : sort.dir === (key === 'last_activity' ? -1 : 1) ? { key, dir: sort.dir === 1 ? -1 : 1 } : null);
    setPage(0);
  };
  // A request the runner has not started yet has no job; it shows here as queued so it can be found and cancelled.
  const waiting = (requests.data ?? []).filter((r) => waitingForRunner(r) && !r.job_id && !r.dismissed_at && !needsMe && inGroup('queued') && hit(requestSummary(r)));
  const PAGE_SIZE = 20;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const shownRows = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  return (
    <Section
      title="Jobs"
      actions={
        <div className="filters">
          <a className="button" href="#/new" data-testid="new-job-link">
            New job
          </a>
          <input type="search" placeholder="Search ticket or title" aria-label="Search jobs" data-testid="jobs-search" value={text} onChange={(e) => { setText(e.target.value); setPage(0); }} />
          <label>
            <input type="checkbox" checked={needsMe} onChange={(e) => { setNeedsMe(e.target.checked); setPage(0); }} /> Needs me
          </label>
          <StateFilter value={states} onChange={(v) => { setStates(v); setPage(0); }} />
          {filtered && <button type="button" data-testid="jobs-clear" onClick={clearFilters}>Clear filters</button>}
        </div>
      }
    >
      {error && <p className="error">{error}</p>}
      {rows.length + waiting.length === 0 ? (
        filtered ? (
          <p className="muted">No jobs match. <button type="button" className="link" onClick={clearFilters}>Clear filters</button></p>
        ) : (
          <p className="muted">
            No jobs yet. <a href="#/new">Start one</a> from a ticket link or a prompt.
          </p>
        )
      ) : (
        <table>
          <thead>
            <tr>
              <SortHeader label="Ticket" col="ticket" sort={sort} onSort={sortBy} />
              <SortHeader label="Title" col="title" sort={sort} onSort={sortBy} />
              <SortHeader label="State" col="status" sort={sort} onSort={sortBy} />
              <th>Next action</th>
              <th>Staff</th>
              <SortHeader label="Last activity" col="last_activity" sort={sort} onSort={sortBy} />
              <th />
            </tr>
          </thead>
          <tbody>
            {(current === 0 ? waiting : []).map((r) => (
              <tr key={r.id} data-testid="request-row" data-request-id={r.id} data-status="queued">
                <td className="nowrap">
                  <a href="#/new">Request</a>
                </td>
                <td>
                  {requestSummary(r)} <span className="muted">in {r.repo_path}</span>
                </td>
                <td>
                  <Pill value="queued" />
                </td>
                <td>
                  Waiting for the runner to start Staff. <CancelRequest id={r.id} onDone={requests.reload} />
                </td>
                <td />
                <td className="muted nowrap">
                  <Ago ts={r.created_at} />
                </td>
                <td />
              </tr>
            ))}
            {shownRows.map((j) => (
              <tr key={j.id} className={j.parent_job_id ? 'child' : ''} data-testid="job-row" data-job-id={j.id} data-identifier={j.linear_identifier} data-status={j.status}>
                <td className="nowrap">
                  <a href={`#/jobs/${j.id}`}>{j.linear_identifier}</a>
                </td>
                <td>
                  {j.title} {j.required ? null : <span className="muted">(optional)</span>} {j.linear_diverged ? <Pill value="diverged" kind="flag" /> : null}
                </td>
                <td className="nowrap">
                  <Pill value={j.status} /> {j.control !== 'continue' && <Pill value={j.control} kind="control" />}
                </td>
                <td className={j.next_action === 'Client decision needed' ? 'attention' : ''}>{j.next_action}</td>
                <td>
                  <Who id={j.staff_agent_id} names={names} />
                </td>
                <td className="muted nowrap">
                  <Ago ts={j.last_activity} />
                </td>
                <td className="nowrap">{!['done', 'cancelled'].includes(j.status) && <MarkDone id={j.id} small />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pages > 1 && (
        <div className="pager" data-testid="jobs-pager">
          <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button>
          <span className="muted">
            Page {current + 1} of {pages} · {rows.length} jobs
          </span>
          <button type="button" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</button>
        </div>
      )}
    </Section>
  );
}

const STATE_GROUPS = [
  { value: 'in_progress', label: 'In progress' },
  { value: 'ready', label: 'Ready' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
];

/** The filter groups the detailed states: "In progress" is everything that is still going on, so it includes planning and review. */
function stateGroup(status: string) {
  return ['ready', 'done', 'cancelled'].includes(status) ? status : 'in_progress';
}

type JobSortKey = 'ticket' | 'title' | 'status' | 'last_activity';
// The lifecycle order of JOB_STATUSES in src/jobs.ts, so a State sort reads from start to finish.
const STATUS_ORDER = ['queued', 'refining', 'planning', 'ready', 'in_progress', 'in_review', 'delivering', 'blocked', 'done', 'cancelled'];

function compareJobs(a: Json, b: Json, key: JobSortKey) {
  if (key === 'status') return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
  if (key === 'last_activity') return (Date.parse(a.last_activity ?? '') || 0) - (Date.parse(b.last_activity ?? '') || 0);
  const field = key === 'ticket' ? 'linear_identifier' : 'title';
  return String(a[field] ?? '').localeCompare(String(b[field] ?? ''), undefined, { numeric: true, sensitivity: 'base' });
}

function SortHeader({ label, col, sort, onSort }: { label: string; col: JobSortKey; sort: { key: JobSortKey; dir: 1 | -1 } | null; onSort: (key: JobSortKey) => void }) {
  const dir = sort?.key === col ? sort.dir : 0;
  return (
    <th aria-sort={dir === 1 ? 'ascending' : dir === -1 ? 'descending' : 'none'}>
      <button type="button" className={`sort${dir ? ' on' : ''}`} data-testid={`sort-${col}`} onClick={() => onSort(col)}>
        {label}
        <span className="arrows" aria-hidden="true">
          <i className={dir === 1 ? 'on' : ''} />
          <i className={dir === -1 ? 'on' : ''} />
        </span>
      </button>
    </th>
  );
}

/** A dropdown of state groups with a checkbox each. None ticked means every state. */
function StateFilter({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  const summary =
    value.length === 0 ? 'All states' : value.length === 1 ? STATE_GROUPS.find((g) => g.value === value[0])?.label : `${value.length} states`;
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : STATE_GROUPS.map((g) => g.value).filter((x) => x === v || value.includes(x)));
  return (
    <details className="multi-select" ref={ref} data-testid="jobs-states">
      <summary aria-label="Filter by state">{summary}</summary>
      <div className="menu">
        {STATE_GROUPS.map((g) => (
          <label key={g.value}>
            <input type="checkbox" checked={value.includes(g.value)} onChange={() => toggle(g.value)} /> <span className={`pill status-${g.value}`}>{g.label}</span>
          </label>
        ))}
        <div className="menu-foot">
          <button type="button" className="link" onClick={() => onChange([])}>All states</button>
          <button type="button" className="link" onClick={() => onChange(STATE_GROUPS.map((g) => g.value).filter((v) => v !== 'cancelled'))}>All but cancelled</button>
        </div>
      </div>
    </details>
  );
}

function JobPage({ id, version, names }: { id: string; version: number; names: Names }) {
  const { data, error, reload: reloadJob } = useData<Json>(`/api/jobs/${id}`, version);
  const events = useData<Json[]>(`/api/events?job_id=${id}&limit=60`, version);
  const staff = useData<Json[]>('/api/agents', version);
  const act = useAction();
  const [newStaff, setNewStaff] = useState('');
  const [replaceSent, setReplaceSent] = useState(false);
  const [pendingReplacementId, setPendingReplacementId] = useState<string | null>(null);
  const request = data?.replacement_request;
  const replacement = request && (!pendingReplacementId || request.id === pendingReplacementId) ? request : null;
  const replacing = replacement?.status === 'queued' || replacement?.status === 'started';
  const ownerIsNewStaff = replacement?.status === 'registered' && data?.job?.staff_agent_id === replacement.staff_agent_id;
  const newStaffPresence = (staff.data ?? []).find((a) => a.id === replacement?.staff_agent_id)?.presence;
  const newStaffOnline = ['active', 'waiting', 'working', 'starting'].includes(newStaffPresence);
  const registering = ownerIsNewStaff && !newStaffOnline;
  const justAssigned = ownerIsNewStaff && newStaffOnline && newStaff === '__new__' && pendingReplacementId === replacement?.id;
  const replacementPending = replaceSent || replacing || registering || justAssigned;
  const reloadStaff = staff.reload;
  useEffect(() => {
    if (!replacementPending) return;
    const t = setInterval(() => { reloadJob(); reloadStaff(); }, 3000);
    return () => clearInterval(t);
  }, [replacementPending, reloadJob, reloadStaff]);
  useEffect(() => {
    if (replacement && replacement.id === pendingReplacementId) setReplaceSent(false);
  }, [replacement?.id, pendingReplacementId]);
  useEffect(() => {
    if (ownerIsNewStaff && newStaffOnline) { setNewStaff(''); setPendingReplacementId(null); }
  }, [ownerIsNewStaff, newStaffOnline]);
  useEffect(() => { setNewStaff(''); setReplaceSent(false); setPendingReplacementId(null); }, [id]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading</p>;
  const j = data.job;
  const snap = j.linear_snapshot ?? {};
  const control = (action: string) => {
    const reason = action === 'cancel' ? prompt('Reason for cancelling?') : null;
    if (action === 'cancel' && !reason) return;
    void act.run(() => post(`/api/jobs/${id}/control`, reason ? { action, reason } : { action }));
  };
  return (
    <>
      <div className="job-head">
        <h2>
          {/^https?:\/\//.test(j.linear_url ?? '') ? (
            <a href={j.linear_url} target="_blank" rel="noreferrer">
              {j.linear_identifier}
            </a>
          ) : (
            j.linear_identifier
          )}{' '}
          {j.title}
        </h2>
        <div data-testid="job-status" data-status={j.status} data-control={j.control}>
          <Pill value={j.status} /> {j.control !== 'continue' && <Pill value={j.control} kind="control" />} {j.linear_diverged ? <Pill value="diverged" kind="flag" /> : null}
        </div>
        <p>
          Next action: <strong data-testid="job-next-action">{j.next_action}</strong> · Staff: <Who id={j.staff_agent_id} names={names} /> · {j.source === 'linear' ? `Linear state: ${j.linear_state ?? 'unknown'} · fetched ${fmt(j.linear_fetched_at)}` : j.source === 'prompt' ? 'Started from a prompt' : `Started from a ticket link, read ${fmt(j.linear_fetched_at)}`}
          {j.parent_job_id && (
            <>
              {' '}
              · <a href={`#/jobs/${j.parent_job_id}`}>parent job</a>
            </>
          )}
        </p>
        <div className="actions">
          {j.status === 'done' && data.subjobs.length === 0 && (
            <button
              onClick={() => {
                const reason = prompt('Why is it not done? For example: CI is red on the PR head.');
                if (reason) void act.run(() => post(`/api/jobs/${id}/reopen`, { reason }));
              }}
            >
              Reopen for delivery
            </button>
          )}
          {!['done', 'cancelled'].includes(j.status) && <MarkDone id={id} />}
          {j.control === 'pause' ? <button onClick={() => control('resume')}>Resume</button> : <button onClick={() => control('pause')}>Pause</button>}
          <button className="danger" onClick={() => control('cancel')}>
            Cancel
          </button>
          {!j.parent_job_id && (
            <span>
              <select value={newStaff} onChange={(e) => setNewStaff(e.target.value)}>
                <option value="">Reassign Staff to...</option>
                <option value="__new__">Start new Staff agent</option>
                {(staff.data ?? [])
                  .filter((a) => a.role === 'staff' && a.id !== j.staff_agent_id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.nickname} ({a.presence})
                    </option>
                  ))}
              </select>
              <button disabled={!newStaff || act.busy || replacementPending} onClick={() => {
                if (newStaff === '__new__') {
                  setReplaceSent(true);
                  void act.run(async () => {
                    // An offline owner has no session to stop, and may own other jobs, so the takeover path starts a Staff without touching it.
                    const ownerOffline = data.blockers.some((b: Json) => b.kind === 'unavailable_owner' && !b.resolved_at);
                    const result = await post<{ id: string }>(`/api/jobs/${id}/${ownerOffline ? 'new-staff' : 'replace-staff'}`, {});
                    setPendingReplacementId(result.id);
                    reloadJob();
                  }).then((ok) => { if (!ok) { setReplaceSent(false); setPendingReplacementId(null); } });
                } else void act.run(() => post(`/api/jobs/${id}/staff`, { staff_agent_id: newStaff }));
              }}>
                {newStaff === '__new__' && replacementPending ? <><Spinner /> Starting Staff...</> : newStaff === '__new__' ? 'Start and reassign' : 'Reassign'}
              </button>
              {(replaceSent || replacement) && (
                <span className={replacement?.status === 'failed' ? 'error' : 'resume-step'} role="status" data-testid="replacement-status">
                  {replaceSent ? 'Replacement request sent...'
                    : replacement?.status === 'failed' ? `Staff did not start: ${startReason(replacement.error)}`
                    : replacement?.status === 'registered' && ownerIsNewStaff && newStaffOnline ? 'New Staff is connected and assigned to this job.'
                    : replacement?.status === 'registered' && ownerIsNewStaff ? 'New Staff registered. Waiting for it to connect...'
                    : replacement?.status === 'registered' ? 'The job was reassigned after this request.'
                    : replacement?.status === 'started' ? 'Staff started. Waiting for it to take over the job...'
                    : replacement?.picked_at && replacement.mode === 'replace' ? 'Runner is stopping the old Staff and starting the new one...'
                    : replacement?.picked_at ? 'Runner is starting the new Staff...'
                    : 'Queued. Waiting for the runner to pick it up (is node scripts/runner.ts running?)'}
                </span>
              )}
            </span>
          )}
        </div>
        {act.error && <p className="error">{act.error}</p>}
      </div>

      {j.status === 'refining' && <RefinePanel job={j} threadId={data.threads[0]?.id} staffPresence={staff.data ? ((staff.data.find((a) => a.id === j.staff_agent_id)?.presence as string | undefined) ?? 'offline') : undefined} version={version} names={names} />}

      <div className="grid">
        <div>

          {data.subjobs.length > 0 && (
            <Section title="Subjobs">
              <ul>
                {data.subjobs.map((c: Json) => (
                  <li key={c.id}>
                    <a href={`#/jobs/${c.id}`}>{c.linear_identifier}</a> {c.title} <Pill value={c.status} /> {c.required ? null : <span className="muted">optional</span>}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {data.depends_on.length > 0 && (
            <Section title="Depends on">
              <ul>
                {data.depends_on.map((d: Json) => (
                  <li key={d.job_id}>
                    <a href={`#/jobs/${d.job_id}`}>{d.linear_identifier}</a> <Pill value={d.status} />
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title="Assignments">
            {data.assignments.length === 0 ? (
              <p className="muted">None</p>
            ) : (
              <table>
                <tbody>
                  {data.assignments.map((a: Json) => (
                    <tr key={a.id}>
                      <td>{a.kind}</td>
                      <td>
                        <Pill value={a.status} kind="asg" />
                      </td>
                      <td>
                        <Who id={a.owner_agent_id} names={names} /> attempt {a.current_attempt}
                      </td>
                      <td className="muted">{a.lease_expires_at ? `lease until ${fmt(a.lease_expires_at)}` : ''}</td>
                      <td className="muted">{a.last_progress}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
          {data.worktrees?.length > 0 && (
            <Section title="Worktrees">
              <table data-testid="job-worktrees">
                <tbody>
                  {data.worktrees.map((w: Json) => (
                    <tr key={w.path}>
                      <td>
                        <code>{w.path}</code>
                      </td>
                      <td>{w.removed_at ? `removed ${fmt(w.removed_at)}` : w.last_result ? 'kept' : ['done', 'cancelled'].includes(data.job.status) ? 'to be removed' : 'in use'}</td>
                      <td className="muted">{!w.removed_at && w.last_result ? w.last_result : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}
          <Artifacts jobId={id} version={version} />
          {data.open_objections?.length > 0 && (
            <Section title="Open objections">
              <p className="muted">An agent objected and neither Staff nor you have answered it yet. Staff cannot confirm delivery while one is open unless it says on the record why.</p>
              <ul data-testid="open-objections">
                {data.open_objections.map((o: Json) => (
                  <li key={o.id}>
                    <Who id={o.author} names={names} /> ({o.stance}) in <a href={`#/threads/${o.thread_id}`}>{o.thread_title}</a> · <Ago ts={o.received_at} />: <Rich text={o.reason ?? o.excerpt} names={names} />
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title="Blockers">
            {data.blockers.length === 0 ? (
              <p className="muted">None</p>
            ) : (
              <>
                {data.blockers.filter((b: Json) => !b.resolved_at).length === 0 && <p className="muted">No open blockers</p>}
                <ul>
                  {data.blockers
                    .filter((b: Json) => !b.resolved_at)
                    .map((b: Json) => (
                      <li key={b.id}>
                        <Pill value={b.kind} kind="blocker" /> <Rich text={b.requested_decision} names={names} /> <a href="#/queue">answer</a>
                      </li>
                    ))}
                </ul>
                {data.blockers.some((b: Json) => b.resolved_at) && (
                  <details>
                    <summary className="muted">{data.blockers.filter((b: Json) => b.resolved_at).length} resolved</summary>
                    <ul>
                      {data.blockers
                        .filter((b: Json) => b.resolved_at)
                        .map((b: Json) => (
                          <li key={b.id} className="muted">
                            <Pill value={b.kind} kind="blocker" /> <Rich text={b.requested_decision} names={names} /> · resolved by <Who id={b.resolved_by} names={names} />:{' '}
                            <Rich text={b.resolution ?? ''} names={names} />
                          </li>
                        ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </Section>
          {data.deliveries.length > 0 && (
            <Section title="Delivery (Copilot loop and CI)">
              {data.deliveries.map((d: Json) => (
                <div key={d.id} className="card" data-testid="delivery" data-confirmed={d.confirmed_at ? 'true' : 'false'}>
                  <p>
                    <a href={d.pr_url} target="_blank" rel="noreferrer">
                      {d.pr_url}
                    </a>{' '}
                    at <code>{d.head_sha}</code> · reported {fmt(d.reported_at)}
                  </p>
                  <p>
                    <em>{d.copilot_status === 'SKIPPED' ? 'Copilot review skipped:' : 'Copilot:'}</em> {d.copilot_summary}
                  </p>
                  <p>
                    <em>CI:</em> {d.ci_summary}
                  </p>
                  {d.confirmed_at ? (
                    <p className="verdict accept">
                      Confirmed by <Who id={d.confirmed_by} names={names} /> {fmt(d.confirmed_at)}: {d.confirmation}
                    </p>
                  ) : (
                    <p className="attention">Waiting for Staff to check CI and confirm</p>
                  )}
                </div>
              ))}
            </Section>
          )}
          <Section title="Ticket">
            <LongText text={snap.description || 'No description'} names={names} />
          </Section>
          <Section title="Acceptance criteria and plan">
            <LongText text={j.acceptance_criteria || 'Not written yet'} names={names} />
            {j.plan && <LongText text={j.plan} names={names} />}
          </Section>
          <Section title="Reviews">
            {data.reviews.length === 0 ? (
              <p className="muted">No review packages yet</p>
            ) : (
              data.reviews.map((p: Json) => (
                <div key={p.id} className="card">
                  <p>
                    <strong>Round {p.round}</strong> · attempt {p.attempt_number} · {fmt(p.submitted_at)}
                  </p>
                  <p>{p.summary}</p>
                  <p>
                    <em>Validation:</em> {p.validation}
                  </p>
                  {p.limitations && (
                    <p>
                      <em>Limitations:</em> {p.limitations}
                    </p>
                  )}
                  {p.artifacts.length > 0 && (
                    <ul>
                      {p.artifacts.map((a: string) => (
                        <li key={a}>{/^https?:\/\//.test(a) ? <a href={a} target="_blank" rel="noreferrer">{a}</a> : a}</li>
                      ))}
                    </ul>
                  )}
                  {p.finding_dispositions.length > 0 && (
                    <ul>
                      {p.finding_dispositions.map((d: Json) => (
                        <li key={d.finding_id}>
                          {d.finding_id}: {d.disposition}, {d.note}
                        </li>
                      ))}
                    </ul>
                  )}
                  {p.verdict ? (
                    <div className={`verdict ${p.verdict.outcome}`}>
                      Verdict: <strong>{p.verdict.outcome}</strong> by <Who id={p.verdict.reviewer} names={names} />
                      <ul>
                        {p.verdict.findings.map((f: Json) => (
                          <li key={f.id}>
                            [{f.required ? 'required' : 'optional'}] {f.id}: {f.text}
                            {f.evidence && <span className="muted"> evidence: {f.evidence}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="muted">Awaiting verdict</p>
                  )}
                </div>
              ))
            )}
          </Section>
          <CodeReviews jobId={id} version={version} />
        </div>
        <div>
          <Section title="Discussion">
            <ul className="threads">
              {data.threads.map((t: Json) => (
                <li key={t.id}>
                  <a href={`#/threads/${t.id}`}>{t.title}</a> <span className="muted">{t.kind}</span> {t.question_state && <Pill value={t.question_state} kind="q" />}{' '}
                  <span className="muted">{t.message_count} messages</span>
                </li>
              ))}
            </ul>
            <NewPost jobId={id} />
          </Section>
          <Section title="Timeline">
            <ul className="timeline">
              {dedupeEvents(events.data ?? []).map((e: Json) => (
                <li key={e.id}>
                  <span className="muted">{fmt(e.created_at)}</span> <code>{e.type}</code> <Who id={e.actor} names={names} />{' '}
                  {e.thread_id && <a href={`#/threads/${e.thread_id}`}>thread</a>} <EventText e={e} names={names} />
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </>
  );
}

/**
 * A prompt job in refinement: the Client reads Staff's proposal and questions, answers or edits, and approves.
 * Whose turn it is comes from the General thread: Staff answers every Client message there, so a Client message last
 * (or no Staff message yet) means Staff is working on it.
 */
function RefinePanel({ job, threadId, staffPresence, version, names }: { job: Json; threadId: string | undefined; staffPresence: string | undefined; version: number; names: Names }) {
  const thread = useData<Json>(threadId ? `/api/threads/${threadId}` : null, version);
  const act = useAction();
  const [plan, setPlan] = useState<string | null>(null);
  const [criteria, setCriteria] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const planValue = plan ?? job.plan ?? '';
  const criteriaValue = criteria ?? job.acceptance_criteria ?? '';
  const dirty = plan !== null || criteria !== null;
  const messages: Json[] = thread.data?.messages ?? [];
  const changed = (value: string | null, current: string | null) => value !== null && value !== (current ?? '');
  const sendable = answer.trim() !== '' || changed(plan, job.plan) || changed(criteria, job.acceptance_criteria);
  const staffSpoke = messages.some((m) => m.author !== 'client');
  const turn = !staffSpoke ? 'drafting' : messages.at(-1)?.author === 'client' ? 'revising' : 'client';
  // Unknown until the agent list loads; an agent missing from the list has ended.
  const staffDown = staffPresence === 'offline' || staffPresence === 'ended';
  // While Staff drafts or revises, it fills the two proposal fields; the Client cannot edit them until it is done.
  const staffWriting = turn !== 'client' && !staffDown;
  const body = () => {
    const b: Json = {};
    if (answer.trim()) b.message = answer;
    if (changed(plan, job.plan)) b.plan = plan;
    if (changed(criteria, job.acceptance_criteria)) b.acceptance_criteria = criteria;
    return b;
  };
  const submit = async (path: 'refine' | 'approve') => {
    const ok = await act.run(() => post(`/api/jobs/${job.id}/${path}`, body()));
    if (ok) {
      setAnswer('');
      setPlan(null);
      setCriteria(null);
    }
  };
  return (
    <section className="card attention-card" data-testid="refine-panel">
      <div className="section-head">
        <h3>Refine this job with Staff</h3>
      </div>
      {turn !== 'client' && staffDown ? (
        <p className="refine-turn attention" data-testid="refine-turn" data-turn="stopped">
          Staff is not running, so nobody is working on the proposal. Resume Staff from Decisions or Agents.
        </p>
      ) : turn === 'client' ? (
        <p className="refine-turn" data-testid="refine-turn" data-turn="client">
          <strong>Your turn.</strong> Answer Staff's questions and send them to keep refining, or start planning when the proposal is right.
        </p>
      ) : (
        <p className="refine-turn" data-testid="refine-turn" data-turn={turn}>
          <Spinner /> {turn === 'drafting' ? 'Staff is reading your prompt and the repository. It will propose the goal, scope and acceptance criteria here and ask its questions.' : 'Staff is revising the proposal after your reply.'}
        </p>
      )}
      <h4>Your prompt</h4>
      <p className="quote" data-testid="refine-prompt">{job.linear_snapshot?.description}</p>
      <form onSubmit={(e) => (e.preventDefault(), void submit('refine'))} className="composer refine-edit">
        <label className="field-label" data-working={staffWriting}>
          <span>Goal, scope and non-goals{staffWriting && <WorkingDots label="Staff is writing" />}</span>
          <textarea
            data-testid="refine-plan"
            value={planValue}
            disabled={staffWriting}
            placeholder={staffWriting ? 'Staff is writing this.' : 'Staff has not proposed this yet.'}
            onChange={(e) => setPlan(e.target.value)}
          />
        </label>
        <label className="field-label" data-working={staffWriting}>
          <span>Acceptance criteria{staffWriting && <WorkingDots label="Staff is writing" />}</span>
          <textarea
            data-testid="refine-criteria"
            value={criteriaValue}
            disabled={staffWriting}
            placeholder={staffWriting ? 'Staff is writing this.' : 'Staff has not proposed criteria yet.'}
            onChange={(e) => setCriteria(e.target.value)}
          />
        </label>
        <h4>Questions and answers</h4>
        {messages.length === 0 ? (
          <p className="muted">No messages yet.</p>
        ) : (
          <ul data-testid="refine-thread">
            {messages.map((m: Json) => (
              <li key={m.id} data-author={m.author}>
                <Who id={m.author} names={names} /> <span className="muted">{fmt(m.received_at)}</span>
                <div className="quote">{m.body}</div>
              </li>
            ))}
          </ul>
        )}
        <label className="field-label">
          Your answer to Staff
          <textarea data-testid="refine-answer" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer the questions, or say what to change." />
        </label>
        <div className="actions">
          {/* Starting planning sends whatever the Client typed or edited along with the approval, so nothing typed is lost. */}
          <button
            type="button"
            className="primary"
            data-testid="refine-approve"
            disabled={act.busy || !criteriaValue.trim()}
            title={!criteriaValue.trim() ? (staffWriting ? 'Staff has not proposed criteria yet. Wait for it to finish.' : 'Staff has not proposed criteria yet. Wait, or write them yourself.') : ''}
            onClick={() => void submit('approve')}
          >
            {sendable ? 'Send and start planning' : 'Approve and start planning'}
          </button>
          <button data-testid="refine-send" disabled={act.busy || !sendable}>
            Send and keep refining
          </button>
          {dirty && (
            <button type="button" className="link" onClick={() => (setPlan(null), setCriteria(null))}>
              Discard edits
            </button>
          )}
        </div>
        {act.error && <p className="error" data-testid="refine-error">{act.error}</p>}
      </form>
    </section>
  );
}

/** Re-renders every `ms` milliseconds, for text that depends on how long something has taken. */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Spinner() {
  return <span className="spinner" role="status" aria-label="Working" />;
}

/** Three dots that pulse one after another, next to a field an agent is filling in. */
function WorkingDots({ label }: { label: string }) {
  return (
    <span className="working-dots" role="status" aria-label={label}>
      <i />
      <i />
      <i />
    </span>
  );
}

/** The reason a start failed, in one line: the first line of the error, or the second when the first is the raw command. */
function startReason(error: unknown): string {
  const lines = String(error ?? '').replace(/^failed:\s*/, '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines[0]?.startsWith('Command failed') && lines[1]) return lines[1];
  return lines[0] ?? 'The runner reported a failure.';
}

const requestSummary = (r: Json) => (r.mode === 'link' ? String(r.source_url ?? '') : `${String(r.prompt ?? '').slice(0, 70)}${String(r.prompt ?? '').length > 70 ? '...' : ''}`);

/** How long after the runner started Staff before a missing job counts as a problem. */
const REGISTER_WARN_MS = 90_000;
/** How long a request may wait for the runner before the Client is told something is wrong. */
const PICKUP_WARN_MS = 20_000;

/** A request is cancellable only until the runner takes its launch: it stays 'queued' until the runner reports, but Cancel is refused once it was picked. */
const waitingForRunner = (r: Json) => r.status === 'queued' && !r.picked_at && !r.finished_at;

/** What happened to one request, as a live status: it spins until Staff has registered the job, or says what went wrong. */
function StartStatus({ request, since, busy, onRetry, onDismiss, onCancel }: { request: Json | undefined; since: number; busy: boolean; onRetry: () => void; onDismiss: () => void; onCancel: () => void }) {
  const now = useNow(1000);
  const status: string = request?.status ?? 'queued';
  if (status === 'registered')
    return (
      <p className="start-status ok" data-testid="start-status" data-state="registered">
        Staff registered the job: <a href={`#/jobs/${request?.job_id}`}>{request?.job_identifier}</a>
      </p>
    );
  if (status === 'failed') {
    const details = String(request?.error ?? '').replace(/^failed:\s*/, '');
    return (
      <div className="start-status failed" role="alert" data-testid="start-status" data-state="failed">
        <p>
          <strong>The job did not start.</strong> {startReason(request?.error)}
        </p>
        {details.trim() !== startReason(request?.error) && (
          <details>
            <summary>Details</summary>
            <pre className="text">{details}</pre>
          </details>
        )}
        <div className="actions">
          <button type="button" data-testid="start-retry" disabled={busy} onClick={onRetry}>
            Retry
          </button>
          <button type="button" className="link" data-testid="start-dismiss" disabled={busy} onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }
  const waited = now - (status === 'started' && request?.finished_at ? new Date(request.finished_at).getTime() : since);
  const slow = status === 'queued' ? waited > PICKUP_WARN_MS : waited > REGISTER_WARN_MS;
  const steps: [string, string][] = [
    ['queued', 'The runner on this machine starts Staff.'],
    ['started', 'Staff reads the request and registers the job.'],
    ['next', request?.mode === 'prompt' ? 'The job page opens. Staff drafts the goal and acceptance criteria there and asks you its questions.' : 'The job page opens, and Staff plans the job.'],
  ];
  const current = steps.findIndex(([s]) => s === status);
  return (
    <div className={`start-status${slow ? ' slow' : ''}`} role="status" data-testid="start-status" data-state={status} data-slow={String(slow)}>
      <p className="quote start-request">{request?.prompt ?? request?.source_url}</p>
      <ol className="start-steps">
        <li className="done">Request saved.</li>
        {steps.map(([key, text], i) => (
          <li key={key} className={i < current ? 'done' : i === current ? 'current' : 'next'}>
            {i === current && <Spinner />} {text}
          </li>
        ))}
      </ol>
      {slow && (
        <p className="attention">
          {status === 'queued'
            ? 'The runner has not picked this up yet. Is node scripts/runner.ts running on this machine?'
            : 'Staff has not registered the job yet. It may still be reading the request. If this goes on, check Agents or ask the Operator.'}
        </p>
      )}
      {waitingForRunner({ status, picked_at: request?.picked_at, finished_at: request?.finished_at }) && (
        <div className="actions">
          <button type="button" className="link" data-testid="start-cancel" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/** On every page except New job: a request that failed to start, or started and never registered a job, stays in view until dismissed. */
function StartProblems({ version }: { version: number }) {
  const list = useData<Json[]>('/api/job-requests', version);
  const now = useNow(30_000);
  const act = useAction();
  const problems = (list.data ?? []).filter(
    (r) => !r.dismissed_at && !r.job_id && (r.status === 'failed' || (r.status === 'started' && now - new Date(r.finished_at ?? r.created_at).getTime() > 3 * 60_000)),
  );
  if (!problems.length) return null;
  return (
    <div className="start-problems" role="alert" data-testid="start-problems">
      {problems.slice(0, 3).map((r) => (
        <div key={r.id} className="start-problem" data-request-id={r.id} data-status={r.status}>
          <div>
            <strong>{r.status === 'failed' ? 'A job did not start.' : 'Staff started but never registered a job.'}</strong>{' '}
            <span className="muted">{requestSummary(r)} in {r.repo_path}</span>
            <div className={r.status === 'failed' ? 'error' : 'muted'}>{r.status === 'failed' ? startReason(r.error) : 'Check Agents or ask the Operator what Staff is doing.'}</div>
          </div>
          <div className="actions">
            {r.status === 'failed' && (
              <button type="button" data-testid="problem-retry" disabled={act.busy} onClick={() => void act.run(async () => (await post(`/api/job-requests/${r.id}/retry`, {}), list.reload()))}>
                Retry
              </button>
            )}
            <button type="button" className="link" data-testid="problem-dismiss" disabled={act.busy} onClick={() => void act.run(async () => (await post(`/api/job-requests/${r.id}/dismiss`, {}), list.reload()))}>
              Dismiss
            </button>
          </div>
        </div>
      ))}
      {problems.length > 3 && <div className="muted">and {problems.length - 3} more on the New job page</div>}
      {act.error && <div className="error">{act.error}</div>}
    </div>
  );
}

/** The Client's way to finish a job that is open but no longer needs an agent. The page refreshes from the job.marked_done event. */
function MarkDone({ id, small }: { id: string; small?: boolean }) {
  const act = useAction();
  return (
    <>
      <button
        type="button"
        className={small ? 'small' : undefined}
        data-testid="mark-done"
        disabled={act.busy}
        onClick={() => {
          const reason = prompt('Why is it done? For example: PR merged, or finished by hand.');
          if (reason) void act.run(() => post(`/api/jobs/${id}/mark-done`, { reason }));
        }}
      >
        Mark done
      </button>
      {act.error && <div className="error">{act.error}</div>}
    </>
  );
}

/** Takes back a request the runner has not picked up yet. The server refuses once the runner has taken it. */
function CancelRequest({ id, onDone }: { id: string; onDone: () => void }) {
  const act = useAction();
  return (
    <>
      <button type="button" className="link" data-testid="request-cancel" disabled={act.busy} onClick={() => void act.run(async () => (await post(`/api/job-requests/${id}/cancel`, {}), onDone()))}>
        Cancel
      </button>
      {act.error && <div className="error">{act.error}</div>}
    </>
  );
}

const REQUEST_STATE: Record<string, string> = {
  queued: 'Waiting for the runner to pick it up (is node scripts/runner.ts running?)',
  started: 'Staff is starting. This row links to the job when Staff registers it.',
  registered: 'Job registered.',
  failed: 'Did not start.',
  cancelled: 'Cancelled before it started.',
};

const ROLE_NAMES: Record<string, string> = { staff: 'Staff', senior: 'Seniors', reviewer: 'Reviewers', researcher: 'Researchers' };
const ROLE_NOTES: Record<string, string> = {
  staff: 'Plans the job and starts the others.',
  senior: 'Implement the work.',
  reviewer: 'Check what a Senior submits.',
  researcher: 'Advise on the board. The default for new personas.',
};

/** The New job form: a ticket link or a prompt, plus repository and base branch. The server checks every field. */
function NewJobPage({ version }: { version: number }) {
  const list = useData<Json[]>('/api/job-requests', version);
  const [mode, setMode] = useState<'link' | 'prompt'>('link');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  // The request this form is watching, and when it was sent: the form shows what happens to it until Staff has registered the job.
  const [pending, setPending] = useState<{ id: string; since: number } | null>(null);
  const act = useAction();
  const roleView = useData<Json>('/api/role-models', version);
  const detected: Json = roleView.data?.detected ?? { runtimes: [], known: false };
  // What each role uses now. The Client's edits are kept apart, so a change saved elsewhere still shows until they edit.
  const roles: Json[] = roleView.data?.roles ?? [];
  const [edits, setEdits] = useState<Record<string, RoleValue>>({});
  const watched: Json | undefined = (list.data ?? []).find((r) => r.id === pending?.id);
  const working = !!pending && !['registered', 'failed', 'cancelled'].includes(watched?.status);
  const waiting = working || (list.data ?? []).some((r) => r.status === 'queued');
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(list.reload, working ? 1500 : 5000);
    return () => clearInterval(t);
  }, [waiting, working]);
  // Once Staff has registered the job, go there: that is where the Client follows it (and refines a prompt job).
  // Until then the form keeps what the Client typed, so a failed start can be fixed and sent again.
  useEffect(() => {
    if (watched?.status === 'registered' && watched.job_id) location.hash = `#/jobs/${watched.job_id}`;
  }, [watched?.status, watched?.job_id]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(null);
    await act.run(async () => {
      // A model chosen here is saved as the model of its role: Staff and the agents it starts read it from there.
      for (const [role, v] of Object.entries(edits)) await post(`/api/role-models/${role}`, v, 'PUT');
      setEdits({});
      roleView.reload();
      const r = await post('/api/job-requests', { mode, url: mode === 'link' ? url : undefined, prompt: mode === 'prompt' ? text : undefined, repo_path: repo, base_branch: branch });
      setPending({ id: r.id, since: Date.now() });
      list.reload();
    });
  };
  const again = (path: string) =>
    act.run(async () => {
      const r = await post(path, {});
      if (path.endsWith('/retry')) setPending({ id: r.id, since: Date.now() });
      else setPending(null);
      list.reload();
    });
  return (
    <>
      <Section title={working ? 'Starting your job' : 'New job'}>
        {working ? (
          <StartStatus request={watched} since={pending!.since} busy={act.busy} onRetry={() => void again(`/api/job-requests/${pending!.id}/retry`)} onDismiss={() => void again(`/api/job-requests/${pending!.id}/dismiss`)} onCancel={() => void again(`/api/job-requests/${pending!.id}/cancel`)} />
        ) : (
          <>
            <p className="muted">
              Start a job from a ticket link or from a prompt. The runner on this machine starts Staff with the model and effort from the Models page. Link: Staff reads the ticket with whatever MCP it has. Prompt: Staff and you refine the goal, scope and acceptance criteria first, and planning starts after you approve.
            </p>
            <form className="composer" onSubmit={submit} data-testid="new-job-form">
              <div className="tabs">
                {(['link', 'prompt'] as const).map((m) => (
                  <button type="button" key={m} data-testid={`mode-${m}`} className={m === mode ? 'active' : ''} onClick={() => setMode(m)}>
                    {m === 'link' ? 'Ticket link' : 'Prompt'}
                  </button>
                ))}
              </div>
              {mode === 'link' ? (
                <label className="field-label">
                  Ticket URL (Linear, Jira, GitHub issue)
                  <input data-testid="job-url" placeholder="https://linear.app/team/issue/ENG-123" value={url} onChange={(e) => setUrl(e.target.value)} />
                </label>
              ) : (
                <label className="field-label">
                  Prompt
                  <textarea data-testid="job-prompt" placeholder="What should be built or fixed, and why?" value={text} onChange={(e) => setText(e.target.value)} />
                </label>
              )}
              <label className="field-label">
                Repository path on this machine (absolute, or starting with ~/)
                <input data-testid="job-repo" placeholder="/home/you/workspace/repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
              </label>
              <label className="field-label">
                Base branch
                <input data-testid="job-branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
              </label>
              <h3>Agents</h3>
              <DetectedRuntimes detected={detected} />
              <table data-testid="job-agents">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Runtime</th>
                    <th>Model</th>
                    <th>Effort</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map((r) => (
                    <tr key={r.role} data-role={r.role}>
                      <td>
                        {ROLE_NAMES[r.role] ?? r.role}
                        <div className="muted">{ROLE_NOTES[r.role]}</div>
                      </td>
                      <ModelPicker
                        role={r.role}
                        value={edits[r.role] ?? { runtime: r.runtime, model: r.model, effort: r.effort }}
                        detected={detected}
                        onChange={(v) => setEdits({ ...edits, [r.role]: v })}
                      />
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">A model you change here is saved as the model for that role, for this job and the ones after it. Running agents keep theirs.</p>
              <ReviewModePicker mode={roleView.data?.review_mode ?? 'auto'} onSaved={roleView.reload} />
              <div className="actions">
                <button className="primary" data-testid="job-submit" disabled={act.busy || working}>
                  {act.busy || working ? <><Spinner /> Starting...</> : 'Start job'}
                </button>
              </div>
              {act.error && <p className="field-error" data-testid="job-error">{act.error}</p>}
              {pending && <StartStatus request={watched} since={pending.since} busy={act.busy} onRetry={() => void again(`/api/job-requests/${pending.id}/retry`)} onDismiss={() => void again(`/api/job-requests/${pending.id}/dismiss`)} onCancel={() => void again(`/api/job-requests/${pending.id}/cancel`)} />}
            </form>
          </>
        )}
      </Section>
      <Section title="Recent requests">
        {(list.data ?? []).length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <table data-testid="job-requests">
            <thead>
              <tr>
                <th>Requested</th>
                <th>Source</th>
                <th>Repository</th>
                <th>State</th>
                <th>Job</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((r) => (
                <tr key={r.id} data-request-id={r.id} data-status={r.status}>
                  <td className="nowrap">{fmt(r.created_at)}</td>
                  <td>{r.mode === 'link' ? <span className="muted">{r.source_url}</span> : <span className="muted">{String(r.prompt ?? '').slice(0, 80)}{String(r.prompt ?? '').length > 80 ? '...' : ''}</span>}</td>
                  <td className="muted">{r.repo_path} @ {r.base_branch}</td>
                  <td>
                    <Pill value={r.status} kind="run" />{' '}
                    <span className={r.status === 'failed' ? 'error' : 'muted'}>{r.status === 'failed' ? startReason(r.error ?? r.result) : REQUEST_STATE[r.status]}</span>
                  </td>
                  <td>{r.job_id ? <a href={`#/jobs/${r.job_id}`}>{r.job_identifier}</a> : ''}</td>
                  <td>{waitingForRunner(r) && <CancelRequest id={r.id} onDone={() => (r.id === pending?.id && setPending(null), list.reload())} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

/** An event's text. The payload keeps only 200 characters of a message, so a cut-off one gets "Show more", which loads the whole message, and "Show less" to fold it back. */
function EventText({ e, names }: { e: Json; names: Names }) {
  const [full, setFull] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const cut = e.thread_id && e.payload?.message_id && typeof e.payload.excerpt === 'string' && e.payload.excerpt.length >= 200;
  if (!cut) return <Rich text={describeEvent(e)} names={names} />;
  const toggle = async () => {
    if (open) return setOpen(false);
    if (full === null) {
      try {
        const thread = await get<Json>(`/api/threads/${e.thread_id}`);
        const message = thread.messages.find((m: Json) => m.id === Number(e.payload.message_id));
        setFull(message?.body ?? e.payload.excerpt);
      } catch (err) {
        return setError(err instanceof Error ? err.message : 'Could not load the message.');
      }
    }
    setOpen(true);
  };
  return (
    <>
      <Rich text={open && full !== null ? full : `${e.payload.excerpt.trimEnd()}…`} names={names} />{' '}
      <button type="button" className="link" onClick={toggle}>
        {open ? 'Show less' : 'Show more'}
      </button>
      {error && <span className="muted"> {error}</span>}
    </>
  );
}

function describeEvent(e: Json): string {
  const p = e.payload ?? {};
  if (e.type === 'job.status') return `${p.from} -> ${p.to}`;
  if (p.excerpt) return p.excerpt.length >= 200 ? `${p.excerpt.trimEnd()}…` : p.excerpt;
  if (p.note) return p.note;
  if (p.title) return p.title;
  if (p.state) return p.state;
  if (p.outcome) return `${p.outcome} (round ${p.round})`;
  return '';
}

function NewPost({ jobId }: { jobId: string }) {
  const [mode, setMode] = useState<'discussion' | 'proposal' | 'question'>('discussion');
  const [body, setBody] = useState('');
  const [q, setQ] = useState({ title: '', summary: '', why: '', waiting: '', options: '', window: 180, staff: true });
  const act = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const done =
      mode === 'question'
        ? await act.run(() =>
            post('/api/questions', {
              job_id: jobId,
              title: q.title,
              summary: q.summary,
              question: body,
              why_it_matters: q.why,
              waiting_work: q.waiting,
              options: q.options || undefined,
              window_sec: Number(q.window),
              requires_staff_decision: q.staff,
            }),
          )
        : await act.run(() => post('/api/messages', { job_id: jobId, type: mode, body }));
    if (done) {
      setBody('');
      setQ({ ...q, title: '', summary: '', why: '', waiting: '', options: '' });
    }
  };
  return (
    <form onSubmit={submit} className="composer" data-testid="new-post">
      <div className="tabs">
        {(['discussion', 'proposal', 'question'] as const).map((m) => (
          <button type="button" key={m} className={m === mode ? 'active' : ''} onClick={() => setMode(m)}>
            {m === 'question' ? 'Timed question' : m}
          </button>
        ))}
      </div>
      {mode === 'question' && (
        <>
          <input placeholder="Title" value={q.title} onChange={(e) => setQ({ ...q, title: e.target.value })} required />
          <textarea placeholder="Context: objective, constraints, progress (optional)" value={q.summary} onChange={(e) => setQ({ ...q, summary: e.target.value })} />
          <input placeholder="Why it matters (optional)" value={q.why} onChange={(e) => setQ({ ...q, why: e.target.value })} />
          <input placeholder="What waits on the answer (optional)" value={q.waiting} onChange={(e) => setQ({ ...q, waiting: e.target.value })} />
          <input placeholder="Options considered (optional)" value={q.options} onChange={(e) => setQ({ ...q, options: e.target.value })} />
          <label>
            Window (60-300 s) <input type="number" min={60} max={300} value={q.window} onChange={(e) => setQ({ ...q, window: Number(e.target.value) })} />
          </label>
          <label>
            <input type="checkbox" checked={q.staff} onChange={(e) => setQ({ ...q, staff: e.target.checked })} /> Needs a Staff decision
          </label>
        </>
      )}
      <textarea placeholder={mode === 'question' ? 'The question' : mode === 'proposal' ? 'Your proposal' : 'Message'} value={body} onChange={(e) => setBody(e.target.value)} required />
      <button disabled={act.busy}>Post as Client</button>
      {act.error && <p className="error">{act.error}</p>}
    </form>
  );
}

function ThreadPage({ id, version, names }: { id: string; version: number; names: Names }) {
  const { data, error } = useData<Json>(`/api/threads/${id}`, version);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading</p>;
  const q = data.question;
  const remaining = q ? Math.max(0, Math.ceil((new Date(q.deadline_at).getTime() - now) / 1000)) : 0;
  return (
    <>
      <p>
        <a href={`#/jobs/${data.thread.job_id}`}>
          {data.job.linear_identifier} {data.job.title}
        </a>
      </p>
      <h2>{data.thread.title}</h2>
      {q && (
        <div className="question-head" data-testid="question-head" data-state={q.state}>
          <Pill value={q.state} kind="q" /> asked by <Who id={q.asker} names={names} /> · owning Staff <Who id={q.owner_staff_id} names={names} /> · window {q.window_sec}s · deadline {fmt(q.deadline_at)}
          {q.state === 'collecting' && <strong> · {remaining}s left</strong>}
          {data.ticket_changed_since_posted && <Pill value="ticket_changed" kind="flag" />}
        </div>
      )}
      <ol className="messages">
        {data.messages.map((m: Json) => (
          <li
            key={m.id}
            className={`msg type-${m.type} ${m.timely === false ? 'late' : ''}`}
            data-testid="message"
            data-message-id={m.id}
            data-type={m.type}
            data-stance={m.stance}
            data-priority={m.priority ?? 'normal'}
            data-author={m.author}
            data-timely={m.timely === null ? '' : String(m.timely)}
          >
            <div className="meta">
              #{m.id} <Who id={m.author} names={names} /> · {m.type} {m.stance !== 'inform' && <Pill value={m.stance} kind="stance" />}
              {m.priority === 'critical' && <Pill value="critical" kind="flag" />}
              {m.intended_decision ? <Pill value="intended_decision" kind="flag" /> : null}
              {m.timely === false && <Pill value="late" kind="flag" />} {m.in_reply_to && <span className="muted">reply to #{m.in_reply_to}</span>}
              <span className="muted"> · {fmt(m.received_at)}</span>
            </div>
            <pre className="text">
              <Rich text={m.body} names={names} />
            </pre>
            {m.reason && <p className="reason">Reason: {m.reason}</p>}
            {m.author === 'client' && <AskedForView message={m} messages={data.messages} names={names} />}
          </li>
        ))}
      </ol>
      {data.decisions.length > 0 && (
        <Section title="Decisions">
          {data.decisions.map((d: Json) => (
            <div key={d.id} className={`card decision ${d.superseded ? 'superseded' : ''}`} data-testid="decision" data-authority={d.authority}>
              <p>
                <strong>{d.body}</strong>
              </p>
              <p>{d.rationale}</p>
              <p className="muted">
                {d.authority} decision by <Who id={d.decided_by} names={names} /> · {fmt(d.created_at)} · considered #{d.considered_message_ids.join(', #') || 'none'}
                {d.superseded ? ' · superseded' : ''}
                {d.unreviewed ? ' · decided without review: no other agent replied before the deadline' : ''}
              </p>
            </div>
          ))}
        </Section>
      )}
      <Reply key={id} threadId={id} messages={data.messages} candidates={data.view_candidates ?? []} questionOpen={q?.state === 'collecting'} />
    </>
  );
}

/** Under a Client message that asked agents for their view: who answered (their first later message) and who has not yet. */
function AskedForView({ message, messages, names }: { message: Json; messages: Json[]; names: Names }) {
  const asked: string[] = (message.mentions ?? []).filter((t: string) => t !== 'client');
  if (!asked.length) return null;
  return (
    <p className="muted asked" data-testid="asked-for-view">
      Asked for a view:{' '}
      {asked.map((agent, i) => {
        const answer = messages.find((r) => r.id > message.id && r.author === agent);
        return (
          <span key={agent} data-agent={agent} data-answered={answer ? 'true' : 'false'}>
            {i > 0 && ', '}
            <Who id={agent} names={names} /> {answer ? `answered in #${answer.id}` : 'not answered yet'}
          </span>
        );
      })}
    </p>
  );
}

function Reply({ threadId, messages, candidates, questionOpen }: { threadId: string; messages: Json[]; candidates: Json[]; questionOpen: boolean }) {
  const [body, setBody] = useState('');
  const [stance, setStance] = useState('inform');
  const [reason, setReason] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [asDecision, setAsDecision] = useState(false);
  const [ask, setAsk] = useState<string[]>([]);
  const act = useAction();
  const asking = !asDecision && ask.length > 0;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = asDecision
      ? await act.run(() => post('/api/decisions', { thread_id: threadId, body, rationale: reason, considered_message_ids: messages.filter((m) => m.type !== 'decision').map((m) => m.id) }))
      : await act.run(() => post('/api/messages', { thread_id: threadId, type: 'reply', body, stance, reason: reason || undefined, in_reply_to: replyTo ? Number(replyTo) : undefined, mentions: asking ? ask : undefined }));
    if (ok) {
      setBody('');
      setReason('');
      setReplyTo('');
      setAsk([]);
    }
  };
  return (
    <form onSubmit={submit} className="composer" data-testid="reply-form">
      <h3>Reply as Client</h3>
      <label>
        <input type="checkbox" checked={asDecision} disabled={questionOpen} onChange={(e) => setAsDecision(e.target.checked)} /> Record as a Client decision (considers every message)
      </label>
      {!asDecision && (
        <div className="row">
          <select value={stance} onChange={(e) => setStance(e.target.value)}>
            {['inform', 'support', 'approve', 'challenge', 'disagree', 'reject'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select value={replyTo} onChange={(e) => setReplyTo(e.target.value)}>
            <option value="">Reply to thread</option>
            {messages.map((m) => (
              <option key={m.id} value={m.id}>
                Reply to #{m.id}
              </option>
            ))}
          </select>
        </div>
      )}
      {!asDecision && candidates.length > 0 && (
        <fieldset className="ask-view" data-testid="ask-view">
          <legend>Ask for their own view (each one answers on this thread)</legend>
          {candidates.map((c) => (
            <label key={c.id}>
              <input type="checkbox" value={c.id} checked={ask.includes(c.id)} onChange={(e) => setAsk(e.target.checked ? [...ask, c.id] : ask.filter((x) => x !== c.id))} /> {c.nickname} ({c.role})
            </label>
          ))}
        </fieldset>
      )}
      <textarea
        placeholder={asDecision ? 'Decision' : asking ? 'What you want their view on (optional)' : 'Message'}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        required={!asking}
      />
      <input placeholder={asDecision ? 'Rationale (required)' : 'Reason (required unless stance is inform)'} value={reason} onChange={(e) => setReason(e.target.value)} />
      <button disabled={act.busy}>{asDecision ? 'Record decision' : asking ? 'Post and ask' : 'Post reply'}</button>
      {act.error && <p className="error">{act.error}</p>}
    </form>
  );
}

function QueuePage({ version, names, refining, inbox, finished, focus }: { version: number; names: Names; refining: Json[]; inbox: { data: Json[] | null; reload: () => void }; finished: { data: Json[] | null; reload: () => void }; focus?: string }) {
  const { data, error } = useData<Json[]>('/api/queue', version);
  const resume = useData<Json>('/api/resume', version);
  const stopped: Json[] = resume.data?.agents ?? [];
  // While someone is stopped, refresh every few seconds so a resumed Staff drops off as soon as it reconnects.
  useEffect(() => {
    if (!stopped.length) return;
    const t = setInterval(resume.reload, 3000);
    return () => clearInterval(t);
  }, [stopped.length]);
  // "Staff is offline" blockers are not decisions: they clear by themselves once that Staff is back, so they are shown as one Resume card per Staff.
  const resumable = new Set(stopped.filter((a) => a.resumable).map((a) => a.agent_id));
  const items = (data ?? []).filter((b) => !(b.kind === 'unavailable_owner' && resumable.has(b.staff_agent_id)));
  return (
    <>
      {stopped.length > 0 && <ResumeSection agents={stopped} launches={resume.data?.launches ?? []} onDiscard={resume.reload} />}
      {refining.length > 0 && (
        <Section title="Jobs to refine">
          <p className="muted">Staff proposed a goal and criteria and may have asked questions. Answer and approve on the job page.</p>
          {refining.map((j) => (
            <div className="card attention-card" key={j.id} data-testid="refine-item" data-job-id={j.id}>
              <p>
                <a href={`#/jobs/${j.id}`}>{j.linear_identifier}</a> {j.title} · <Ago ts={j.last_activity ?? j.updated_at} />
              </p>
              <a className="button primary" href={`#/jobs/${j.id}`}>Open and answer</a>
            </div>
          ))}
        </Section>
      )}
      <Section title="Client decisions">
        {error && <p className="error">{error}</p>}
        {items.length === 0 ? <p className="muted">Nothing needs you right now.</p> : items.map((b) => <QueueItem key={b.id} b={b} names={names} version={version} focus={b.id === focus} />)}
      </Section>
      <FinishedSection jobs={finished.data ?? []} reload={finished.reload} />
      <InboxSection unread={inbox.data ?? []} names={names} version={version} reload={inbox.reload} />
    </>
  );
}

/** Top-level jobs that finished since the Client last looked. Got it hides them; the job stays done. */
function FinishedSection({ jobs, reload }: { jobs: Json[]; reload: () => void }) {
  const act = useAction();
  const seen = (ids?: string[]) => act.run(() => post('/api/finished/seen', ids ? { ids } : {})).then(reload);
  return (
    <Section title="Finished jobs" actions={jobs.length > 1 ? <button className="link" disabled={act.busy} onClick={() => seen()}>Mark all as seen</button> : undefined}>
      <p className="muted">Jobs that reached done since you last looked. A PR may still be waiting for you to merge. Got it hides the job from this list.</p>
      {act.error && <p className="error">{act.error}</p>}
      {jobs.length === 0 && <p className="muted">No newly finished jobs.</p>}
      {jobs.map((j) => (
        <div className="card finished-card" key={j.id} data-testid="finished-item" data-job-id={j.id}>
          <p>
            <a href={`#/jobs/${j.id}`}>{j.linear_identifier}</a> {j.title} · finished <Ago ts={j.done_at} />
          </p>
          <div className="actions">
            <a className="button" href={`#/jobs/${j.id}`}>Open job</a>
            {/^https?:\/\//.test(j.pr_url ?? '') && <a className="button" href={j.pr_url} target="_blank" rel="noreferrer">Open PR</a>}
            <button disabled={act.busy} onClick={() => seen([j.id])}>Got it</button>
          </div>
        </div>
      ))}
    </Section>
  );
}

/** Messages agents tagged to the Client. Nothing to answer: read, then they leave the list. */
function InboxSection({ unread, names, version, reload }: { unread: Json[]; names: Names; version: number; reload: () => void }) {
  const act = useAction();
  // Read messages stay hidden until asked for. The list that includes them is fetched only then.
  const [showRead, setShowRead] = useState(false);
  const all = useData<Json[]>(showRead ? '/api/inbox?read=1' : null, version);
  const messages = showRead ? (all.data ?? []) : unread;
  // Critical messages are pinned above normal ones by the server and never swept by the bulk action below: they need an explicit Got it or an open thread.
  const nonCriticalUnread = unread.filter((m) => m.priority !== 'critical');
  const seen = (ids?: number[]) =>
    act.run(() => post('/api/inbox/seen', ids ? { ids } : {})).then(() => {
      reload();
      if (showRead) all.reload();
    });
  return (
    <Section
      title="Messages for you"
      actions={
        <span className="actions">
          <label>
            <input type="checkbox" checked={showRead} onChange={(e) => setShowRead(e.target.checked)} data-testid="inbox-show-read" /> Show read
          </label>
          {nonCriticalUnread.length > 1 && (
            <button className="link" disabled={act.busy} onClick={() => seen()}>
              Mark all as read
            </button>
          )}
        </span>
      }
    >
      <p className="muted">Agents tag a message to you when you should read it but have nothing to decide. Replying in its thread, or Got it, marks it read and hides it. A critical message is not cleared by Mark all as read.</p>
      {act.error && <p className="error">{act.error}</p>}
      {messages.length === 0 && <p className="muted">{showRead ? 'No messages yet.' : 'No unread messages.'}</p>}
      {messages.map((m) => (
        <div
          className={`card${m.client_seen_at ? ' read' : ''}${m.priority === 'critical' ? ' critical' : ''}`}
          key={m.id}
          data-testid="inbox-item"
          data-message-id={m.id}
          data-read={m.client_seen_at ? 'true' : 'false'}
          data-priority={m.priority ?? 'normal'}
        >
          <p className="muted">
            {m.priority === 'critical' && <><strong className="critical-label">Critical</strong> · </>}
            {m.type === 'dissent' && <><strong>Dissent with a Staff decision</strong> · </>}
            <Who id={m.author} names={names} /> on <a href={`#/jobs/${m.job_id}`}>{m.linear_identifier}</a> {m.job_title} · <Ago ts={m.received_at} />
            {m.client_seen_at && <> · read <Ago ts={m.client_seen_at} /></>}
          </p>
          <LongText text={m.body} names={names} limit={400} />
          <div className="actions">
            <a className="button" href={`#/threads/${m.thread_id}`} onClick={() => !m.client_seen_at && void seen([m.id])}>Open thread</a>
            {!m.client_seen_at && <button disabled={act.busy} onClick={() => seen([m.id])}>Got it</button>}
          </div>
        </div>
      ))}
    </Section>
  );
}

function ResumeSection({ agents, launches, onDiscard }: { agents: Json[]; launches: Json[]; onDiscard: () => void }) {
  const act = useAction();
  // When the button was clicked, to show progress before the server reports the launch.
  const [sent, setSent] = useState<Map<string, number>>(new Map());
  const last = (id: string) => launches.find((l) => l.agent_id === id);
  return (
    <Section title="Bring agents back">
      <p className="muted">
        These Staff sessions stopped (a reboot or a usage limit) while they own open jobs. Resume continues the same Claude Code session; Staff then restarts its Seniors. Researchers do not need this: they run on demand from the Researchers page. Resume needs the runner on this machine: <code>node scripts/runner.ts</code>.
      </p>
      <p className="muted">Discard hides this recovery card. Jobs still assigned to the agent appear below for reassignment.</p>
      {act.error && <p className="error">{act.error}</p>}
      {agents.map((a) => {
        const l = last(a.agent_id);
        // Only a resume asked for after the agent was last seen says anything about now.
        const live = l && new Date(l.requested_at) > new Date(a.last_seen_at) ? l : null;
        const step = resumeStep(live, sent.get(a.agent_id) ?? null, Date.now());
        const mins = live?.finished_at ? Math.max(1, Math.round((Date.now() - new Date(live.finished_at).getTime()) / 60_000)) : 0;
        const skippedWhy = String(live?.result ?? '').replace(/^(ok: )?skipped: /, '');
        const text: Record<string, string> = {
          sent: 'Resume request sent...',
          queued: 'Queued. Waiting for the runner to pick it up (is node scripts/runner.ts running?)',
          starting: 'Starting the session...',
          reconnecting: 'Session started. Waiting up to 2 minutes for it to reconnect to Triglav; this card disappears when it does.',
          skipped: `Not restarted: ${skippedWhy}. Waiting up to 2 minutes for it to reconnect; this card disappears when it does.`,
          stuck: `It did not reconnect to Triglav in the ${mins} minutes since the session started. ${a.transcript_error ? `Its last step failed: ${a.transcript_error}. The session is still open but idle, and it does not retry by itself.` : 'Nothing has been written to its transcript since.'} Restart session stops the idle copy and continues the same conversation.`,
          failed: String(live?.result ?? '').split('\n')[0],
        };
        const canRestart = step === 'failed' || step === 'stuck';
        return (
          <div className="card" key={a.agent_id} data-testid="resume-item" data-step={step ?? ''}>
            <p>
              <strong>{a.nickname}</strong> <span className="muted">({a.role}) · last seen {fmt(a.last_seen_at)} · {a.jobs ? `owns ${a.jobs}` : a.focus ? `focus: ${a.focus}` : 'no open jobs'}</span>
            </p>
            {!step && a.transcript_error && <p className="error">Its last step failed: {a.transcript_error}</p>}
            <div className="actions">
              <button disabled={!a.resumable || act.busy || (!!step && !canRestart)} onClick={() => {
                  setSent((x) => new Map(x).set(a.agent_id, Date.now()));
                  void act.run(() => post(`/api/agents/${a.agent_id}/resume`, {})).then((ok) => ok || setSent((x) => { const n = new Map(x); n.delete(a.agent_id); return n; }));
                }}>
                {step === 'failed' ? 'Retry resume' : step === 'stuck' ? 'Restart session' : 'Resume'}
              </button>
              <button data-testid="discard-resume" disabled={act.busy} onClick={() => void act.run(async () => { await post(`/api/agents/${a.agent_id}/dismiss-resume`, {}); onDiscard(); })}>Discard</button>
              {!a.resumable && <span className="muted">Its session is not known yet (telemetry reads transcripts once a minute).</span>}
              {step && <span className={step === 'failed' || step === 'stuck' ? 'error' : 'resume-step'}>{text[step]}</span>}
            </div>
            {a.command && <CommandBlock label="Or run it yourself" command={a.command} />}
          </div>
        );
      })}
    </Section>
  );
}

/** Splits "(1) a; (2) b" into a numbered list and several sentences into bullets, so long asks stay readable. */
/** A command the Client runs, in its own box with a Copy button, so it is clear where it starts and ends. */
function CommandBlock({ command, label, n }: { command: string; label?: string; n?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="command-block" data-testid="command-block">
      {(label || n) && <div className="command-label">{n ? `${n}. ` : ''}{label}</div>}
      <div className="command-row">
        <pre>{command}</pre>
        <button
          onClick={() => void navigator.clipboard.writeText(command).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
          aria-label={`Copy command${label ? `: ${label}` : ''}`}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

/** "1. a 2. b", "1) a 2) b" or "(1) a (2) b", inline or on lines, as a lead and items. Only numbers that run 1, 2, 3 count, so "PR 3978." is not an item. */
export function splitNumbered(text: string): { lead: string; items: string[] } | null {
  const marks: { at: number; end: number }[] = [];
  for (const m of text.matchAll(/(?:^|\s)(?:\((\d{1,2})\)|(\d{1,2})[.)])\s+/g)) {
    if (Number(m[1] ?? m[2]) !== marks.length + 1) continue;
    marks.push({ at: m.index, end: m.index + m[0].length });
  }
  if (marks.length < 2) return null;
  return { lead: text.slice(0, marks[0]!.at).trim(), items: marks.map((mk, i) => text.slice(mk.end, marks[i + 1]?.at ?? text.length).trim()) };
}

const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z])/;
const BULLET = /^\s*[-*\u2022]\s+/;

/**
 * Agent text for the Client, laid out for reading: blank lines make paragraphs, numbered or "-" items become lists,
 * and a paragraph of five or more sentences is broken into even chunks of at most three. With sentenceBullets, a paragraph of
 * three or more sentences becomes a bullet list (used for recommendations).
 */
function Prose({ text, names, sentenceBullets = false }: { text: string; names: Names; sentenceBullets?: boolean }) {
  const paragraphs = String(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return <div className="prose">{paragraphs.map((p, i) => <Paragraph key={i} text={p} names={names} sentenceBullets={sentenceBullets} />)}</div>;
}

function Paragraph({ text, names, sentenceBullets }: { text: string; names: Names; sentenceBullets: boolean }) {
  const lead = (t: string) => t && <p><Rich names={names} text={t.replace(/:$/, '')} /></p>;
  const lines = text.split('\n').filter((l) => l.trim());
  const first = lines.findIndex((l) => BULLET.test(l));
  if (first >= 0 && lines.length - first >= 2 && lines.slice(first).every((l) => BULLET.test(l))) {
    return (
      <>
        {lead(lines.slice(0, first).join(' '))}
        <ul>{lines.slice(first).map((l, i) => <li key={i}><Rich names={names} text={l.replace(BULLET, '')} /></li>)}</ul>
      </>
    );
  }
  const numbered = splitNumbered(text);
  if (numbered) {
    return (
      <>
        {lead(numbered.lead)}
        <ol>{numbered.items.map((t, i) => <li key={i}><Rich names={names} text={t.replace(/[;,]?\s*(and)?$/, '')} /></li>)}</ol>
      </>
    );
  }
  const sentences = text.split(SENTENCE_END);
  if (sentenceBullets && sentences.length > 2) return <ul>{sentences.map((t, i) => <li key={i}><Rich names={names} text={t} /></li>)}</ul>;
  if (sentences.length < 5) return <p><Rich names={names} text={text} /></p>;
  // Even chunks of at most three sentences, so no sentence is left alone at the end.
  const count = Math.ceil(sentences.length / 3);
  const chunks = Array.from({ length: count }, (_, i) => sentences.slice(Math.round((i * sentences.length) / count), Math.round(((i + 1) * sentences.length) / count)).join(' '));
  return <>{chunks.map((c, i) => <p key={i}><Rich names={names} text={c} /></p>)}</>;
}

function QueueItem({ b, names, version, focus }: { b: Json; names: Names; version: number; focus?: boolean }) {
  // Arriving from the map (#/queue/<id>) opens this decision and brings it into view.
  const card = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (focus) card.current?.scrollIntoView({ block: 'start' });
  }, [focus]);
  const [answer, setAnswer] = useState('');
  const [staffId, setStaffId] = useState('');
  const act = useAction();
  const owner = b.kind === 'unavailable_owner';
  const staff = useData<Json[]>(owner ? '/api/agents' : null, 0);
  const candidates = (staff.data ?? []).filter((a) => a.role === 'staff');
  // Starting Staff takes a while after the click returns. The button stays disabled until the takeover request has
  // failed or the new Staff has taken the job (the card then goes away); the server also ignores a repeated click for 10 minutes.
  const requests = useData<Json[]>(owner ? '/api/job-requests' : null, version);
  const now = useNow(30_000);
  const starting = (requests.data ?? []).some((r) => r.mode === 'takeover' && r.job_id === b.job_id && ['queued', 'started'].includes(r.status) && now - new Date(r.created_at).getTime() < 10 * 60_000);
  // The newest takeover for this job since the blocker, shown only when it failed: no stale error while a retry runs.
  const latestTakeover = (requests.data ?? []).filter((r) => r.mode === 'takeover' && r.job_id === b.job_id && new Date(r.created_at).getTime() >= new Date(b.created_at).getTime()).sort((x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime())[0];
  const takeoverError: string | null = latestTakeover?.status === 'failed' ? (latestTakeover.error ?? 'The new Staff did not start.') : null;
  // A failed launch emits no event, so the list is polled while a takeover starts. Otherwise the button would spin
  // until the ten minutes are over.
  const reloadRequests = requests.reload;
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(reloadRequests, 3000);
    return () => clearInterval(t);
  }, [starting]);
  return (
    <details ref={card} open={focus || undefined} className="card attention-card decision-card" data-testid="queue-item" data-job-id={b.job_id} data-kind={b.kind}>
      {/* Collapsed, a decision is one line; the summary is the line that stays visible. */}
      <summary>
        <Pill value={b.kind} kind="blocker" /> <a href={`#/jobs/${b.job_id}`}>{b.linear_identifier}</a> {b.job_title} · raised by <Rich names={names} text={b.raised_by} /> · {fmt(b.created_at)}
      </summary>
      {/* Two columns on a wide screen: what happened on the left, the question and the answer on the right. */}
      <div className="decision-body">
        <div className="decision-main">
          {b.context && (
            <div className="decision-context">
              <h4>Problem</h4>
              <Prose names={names} text={b.context} />
            </div>
          )}
          {(() => {
            const advice: Json[] = (typeof b.advice === 'string' ? JSON.parse(b.advice) : b.advice) ?? [];
            return advice.length > 0 && (
              <div className="decision-advice">
                <h4>Researchers</h4>
                {advice.map((x) => (
                  <div key={x.agent_id} className="advice-item">
                    <strong><Rich names={names} text={x.agent_id} /></strong>
                    <Prose names={names} text={x.body} />
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
        <div className="decision-side">
          <div className="decision-ask">
            <h4>Question</h4>
            <Prose names={names} text={b.requested_decision} />
          </div>
          {(() => {
            const commands: { label?: string; command: string }[] = (typeof b.commands === 'string' ? JSON.parse(b.commands) : b.commands) ?? [];
            return commands.length > 0 && (
              <div className="decision-commands">
                <h4>Commands to run</h4>
                {commands.map((c, i) => <CommandBlock key={i} n={commands.length > 1 ? i + 1 : undefined} label={c.label} command={c.command} />)}
              </div>
            );
          })()}
          {b.recommendation && (
            <div className="decision-rec">
              <h4>Recommendation</h4>
              <Prose names={names} text={b.recommendation} sentenceBullets />
            </div>
          )}
          <p className="muted">Unblocks when: {b.unblock_condition}</p>
          {b.kind === 'unavailable_owner' ? (
            <div className="actions">
              <button
                data-testid="start-new-staff"
                disabled={act.busy || starting}
                onClick={() => act.run(async () => (await post(`/api/jobs/${b.job_id}/new-staff`, {}), requests.reload()))}
              >
                {act.busy || starting ? <><Spinner /> Starting Staff...</> : 'Start new Staff'}
              </button>
              {candidates.length > 0 && (
                <>
                  <select aria-label="New Staff" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                    <option value="">Or reassign to...</option>
                    {candidates.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.nickname} ({a.presence})
                      </option>
                    ))}
                  </select>
                  <button disabled={!staffId || act.busy || starting} onClick={() => act.run(() => post(`/api/jobs/${b.job_id}/staff`, { staff_agent_id: staffId }))}>
                    Reassign
                  </button>
                </>
              )}
              {act.error && <p className="error">{act.error}</p>}
              {takeoverError && <p className="error" data-testid="takeover-error">The last attempt to start a new Staff failed: {takeoverError}</p>}
            </div>
          ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(() => post(`/api/blockers/${b.id}/resolve`, { resolution: answer }));
            }}
          >
            <textarea placeholder="Your decision" value={answer} onChange={(e) => setAnswer(e.target.value)} required />
            <button disabled={act.busy}>Answer and unblock</button>
            {b.recommendation && Boolean(Number(b.recommendation_actionable)) && (
              <button type="button" data-testid="accept-recommendation" disabled={act.busy} onClick={() => act.run(() => post(`/api/blockers/${b.id}/resolve`, { resolution: b.recommendation }))}>
                Accept recommendation
              </button>
            )}
            <button type="button" data-testid="dismiss-decision" disabled={act.busy} onClick={() => act.run(() => post(`/api/blockers/${b.id}/dismiss`, {}))}>
              No longer applies, dismiss
            </button>
            {act.error && <p className="error">{act.error}</p>}
          </form>
          )}
        </div>
      </div>
    </details>
  );
}

function AgentsPage({ version, names }: { version: number; names: Names }) {
  const [all, setAll] = useState(false);
  const { data, error } = useData<Json[]>(`/api/agents${all ? '?all=1' : ''}`, version);
  return (
    <Section
      title={all ? 'All agents' : 'Active agents'}
      actions={
        <label>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Include offline and ended
        </label>
      }
    >
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Nickname</th>
            <th>Role</th>
            <th>Focus</th>
            <th>Runtime / model</th>
            <th>Presence</th>
            <th>Holds</th>
            <th>Started by</th>
            <th>Last seen</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((a) => (
            <tr key={a.id} data-testid="agent-row" data-agent-id={a.id} data-presence={a.presence}>
              <td title={a.id}>
                <a href={`#/agents/${a.id}`}>{a.nickname}</a>
              </td>
              <td>{a.role}</td>
              <td>{a.focus}</td>
              <td title={[a.runtime, a.model, a.effort && `effort ${a.effort}`].filter(Boolean).join(' / ')}>
                {a.runtime}
                {a.model ? ` / ${a.model}` : ''}
              </td>
              <td>
                <Pill value={a.presence} kind="presence" />
              </td>
              <td>
                {a.held.map((h: Json) => (
                  <a key={h.assignment_id} href={`#/jobs/${h.job_id}`}>
                    {h.kind} #{h.attempt}{' '}
                  </a>
                ))}
              </td>
              <td className="muted">{a.parent_agent_id ? <Who id={a.parent_agent_id} names={names} /> : 'Client'}</td>
              <td className="muted nowrap">
                <Ago ts={a.last_seen_at} />
              </td>
              <td>{a.presence !== 'ended' && a.role !== 'researcher' && <PokeButton agentId={a.id} poke={a.poke} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/** The poke reply is a message the agent tags to the Client. Until it arrives the button says so, and then it links to the reply. */
function PokeButton({ agentId, poke }: { agentId: string; poke?: Json | null }) {
  const { error, busy, run } = useAction();
  // Shown the moment the button is clicked, before the server lists the poke.
  const [sent, setSent] = useState(false);
  const waiting = poke && !poke.reply;
  return (
    <span className="actions">
      <button
        disabled={busy}
        title="Ask this agent to report its status. Reaches it on its next orchestrator call. Its reply shows up in your Inbox."
        onClick={() => run(() => post(`/api/agents/${agentId}/poke`, {})).then((ok) => ok && setSent(true))}
      >
        Poke
      </button>
      {waiting && (
        <span className="muted" data-testid="poke-waiting">
          poked <Ago ts={poke.poked_at} />, waiting for a reply
        </span>
      )}
      {!waiting && poke?.reply && (
        <a href={`#/threads/${poke.reply.thread_id}`} title={poke.reply.excerpt} data-testid="poke-replied">
          replied <Ago ts={poke.reply.at} />
        </a>
      )}
      {sent && !poke && <span className="muted">sent</span>}
      {error && <span className="error">{error}</span>}
    </span>
  );
}

/** The Client writes to an agent. It travels as a poke with the Client's own text, so the agent's reply is tracked next to Poke. */
function MessageAgent({ agentId, nickname }: { agentId: string; nickname: string }) {
  const act = useAction();
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const send = async () => {
    if (!text.trim()) return;
    if (await act.run(() => post(`/api/agents/${agentId}/poke`, { note: text.trim() }))) {
      setText('');
      setSent(true);
    }
  };
  return (
    <form className="card message-agent" data-testid="message-agent" onSubmit={(e) => (e.preventDefault(), void send())}>
      <h3>Message {nickname}</h3>
      <textarea
        placeholder={`Message ${nickname}`}
        aria-label={`Message ${nickname}`}
        value={text}
        maxLength={8000}
        onChange={(e) => (setText(e.target.value), setSent(false))}
        onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (e.preventDefault(), void send())}
      />
      <div className="actions">
        <button disabled={act.busy || !text.trim()}>Send message</button>
        <span className="muted">{sent ? 'Sent. The reply will show in your Inbox.' : 'Ctrl+Enter sends. It reaches the agent on its next call to Triglav.'}</span>
        {act.error && <span className="error">{act.error}</span>}
      </div>
    </form>
  );
}

function AgentPage({ id, version, names }: { id: string; version: number; names: Names }) {
  const { data, error } = useData<Json>(`/api/agents/${id}`, version);
  const detected = useData<Json>('/api/runtimes', version);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading</p>;
  const a = data.agent;
  return (
    <>
      <div className="job-head">
        <h2>
          {a.nickname} <span className="muted">({a.role})</span>
        </h2>
        <div className="actions">
          <Pill value={a.presence} kind="presence" />
          <span className="muted">
            {a.runtime}
            {a.model ? ` / ${a.model}` : ''}
            {a.effort ? ` / ${a.effort}` : ''} · last seen {fmt(a.last_seen_at)}
          </span>
          {a.presence !== 'ended' && a.role !== 'researcher' && <PokeButton agentId={a.id} poke={a.poke} />}
        </div>
        {a.presence !== 'ended' && a.role !== 'researcher' && <MessageAgent agentId={a.id} nickname={a.nickname} />}
        {a.presence === 'stale' || a.presence === 'offline' ? (
          <p className="attention" data-testid="agent-not-listening">
            This agent is not calling the orchestrator. A poke reaches it only when it calls again. If its CLI session ended its turn, send it a message in that CLI.
          </p>
        ) : null}
        {a.presence !== 'ended' && <EditAgent a={a} detected={detected.data ?? {}} />}
      </div>
      {a.role !== 'researcher' && <AgentStream id={a.id} version={version} live={['active', 'waiting', 'working', 'starting'].includes(a.presence)} />}
      <div className="grid">
        <Section title="Activity">
          <ul className="timeline" data-testid="agent-activity">
            {dedupeEvents(data.events).map((e: Json) => (
              <li key={e.id}>
                <span className="muted">{fmt(e.created_at)}</span> {e.actor === a.id ? '' : <Who id={e.actor} names={names} />} <strong>{e.type}</strong>{' '}
                {e.job_id && <a href={`#/jobs/${e.job_id}`}>job</a>} {e.thread_id && <a href={`#/threads/${e.thread_id}`}>thread</a>} <Rich text={describeEvent(e)} names={names} />
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Board messages">
          {data.messages.length === 0 && <p className="muted">None yet.</p>}
          {data.messages.map((m: Json) => (
            <div key={m.id} className="card">
              <div className="muted">
                {fmt(m.received_at)} · <a href={`#/threads/${m.thread_id}`}>{m.thread_title}</a> · {m.type} <Pill value={m.stance} kind="stance" />
              </div>
              {m.reason && <p className="reason">{m.reason}</p>}
              <LongText text={m.body} names={names} limit={700} />
            </div>
          ))}
        </Section>
      </div>
    </>
  );
}

const STREAM_KINDS: [kind: string, label: string][] = [
  ['thinking', 'Thinking'],
  ['text', 'Messages'],
  ['tool', 'Tool calls'],
  ['result', 'Tool results'],
  ['user', 'Prompts'],
  ['error', 'Errors'],
];

/**
 * What the agent's CLI wrote to its transcript: its thinking, messages, tool calls and their results. Plain text only, because
 * it is agent text. Claude Code usually keeps no thinking text (only a signature), so that count is shown instead.
 * It reloads every 5 seconds while the agent is live, and keeps the view at the bottom unless the Client scrolled up.
 */
function AgentStream({ id, version, live }: { id: string; version: number; live: boolean }) {
  const [shown, setShown] = useState<Set<string>>(new Set(['thinking', 'text', 'tool', 'error']));
  const [limit, setLimit] = useState(300);
  const [tick, setTick] = useState(0);
  // Collapsed by default: nothing is fetched or polled until the Client opens it.
  const [open, setOpen] = useState(false);
  const { data, error } = useData<Json>(open ? `/api/agents/${id}/stream?limit=${limit}` : null, version + tick);
  useEffect(() => {
    if (!live || !open) return;
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [live, open]);
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [data]);
  const entries: Json[] = (data?.entries ?? []).filter((e: Json) => shown.has(e.kind));
  return (
    <details className="panel-details" data-testid="agent-stream-section" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        Stream <span className="muted hint">messages, tool calls and results</span>
      </summary>
      <div className="actions" role="group" aria-label="Stream filter">
        {STREAM_KINDS.map(([kind, label]) => (
          <label key={kind}>
            <input
              type="checkbox"
              checked={shown.has(kind)}
              onChange={(e) => setShown((prev) => new Set(e.target.checked ? [...prev, kind] : [...prev].filter((k) => k !== kind)))}
            />{' '}
            {label}
          </label>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {data && data.files === 0 && <p className="muted">No transcript is known for this agent yet. Telemetry reads transcripts once a minute.</p>}
      {data && data.hidden_thinking > 0 && (
        <p className="muted">
          {data.hidden_thinking} thinking {data.hidden_thinking === 1 ? 'block has' : 'blocks have'} no text. Claude Code usually saves only a signature of its thinking, so it cannot be shown.
        </p>
      )}
      <div
        className="stream"
        data-testid="agent-stream"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {data?.more && (
          <button className="link" onClick={() => setLimit((n) => Math.min(1000, n + 300))} disabled={limit >= 1000}>
            {limit >= 1000 ? 'Only the newest entries are kept' : 'Load older'}
          </button>
        )}
        {entries.map((e: Json, i: number) => (
          <div key={`${e.at}-${i}`} className={`stream-entry ${e.kind}`}>
            <div className="muted">
              {fmt(e.at)} · {e.kind === 'tool' ? `tool ${e.tool}` : e.kind}
            </div>
            <pre className="text">
              {e.text}
              {e.cut ? '\n[cut]' : ''}
            </pre>
          </div>
        ))}
        {data && data.files > 0 && entries.length === 0 && <p className="muted">Nothing to show with these filters.</p>}
      </div>
    </details>
  );
}

/**
 * Rename an agent, or change its model and effort. The runtime stays as it is. A running Claude Code Staff is restarted
 * with its conversation kept, because Claude Code cannot change the model of a live session. Seniors and reviewers are
 * started by Staff, so only their name can change here.
 */
function EditAgent({ a, detected }: { a: Json; detected: Json }) {
  const modelEditable = (a.role === 'staff' && a.runtime === 'claude-code') || a.role === 'researcher';
  const [name, setName] = useState<string>(a.nickname);
  const [v, setV] = useState<RoleValue>({ runtime: a.runtime, model: a.model ?? '', effort: a.effort ?? '' });
  useEffect(() => setName(a.nickname), [a.nickname]);
  useEffect(() => setV({ runtime: a.runtime, model: a.model ?? '', effort: a.effort ?? '' }), [a.runtime, a.model, a.effort]);
  const [note, setNote] = useState('');
  const { error, busy, run } = useAction();
  const nameChanged = name.trim() !== a.nickname;
  const modelChanged = modelEditable && (v.model !== (a.model ?? '') || v.effort !== (a.effort ?? ''));
  const save = async () => {
    setNote('');
    const ok = await run(async () => {
      const r = await post<Json>(`/api/agents/${a.id}`, { ...(nameChanged ? { nickname: name.trim() } : {}), ...(modelChanged ? { model: v.model, effort: v.effort } : {}) }, 'PUT');
      setNote(r.switch_queued ? 'Saved. The host runner restarts the session within a few seconds.' : 'Saved.');
    });
    return ok;
  };
  return (
    <details className="panel-details" data-testid="edit-agent">
      <summary>
        Edit <span className="muted hint">{modelEditable ? 'name, model and effort' : 'name'}</span>
      </summary>
      <div className="actions">
        <label>
          Name <input aria-label="agent name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </label>
        {modelEditable && (
          <table>
            <tbody>
              <tr>
                <ModelPicker role="agent" value={v} detected={detected} onChange={setV} runtimes={[a.runtime]} />
              </tr>
            </tbody>
          </table>
        )}
        <button disabled={busy || (!nameChanged && !modelChanged) || !name.trim() || (modelChanged && (!v.model || !v.effort))} onClick={save}>
          Save
        </button>
        {note && <span className="muted">{note}</span>}
        {error && <span className="error">{error}</span>}
      </div>
      {a.role === 'staff' && modelEditable && <p className="muted">A new model or effort restarts this session with its conversation kept. Its open wait is cut and it reads its context again.</p>}
      {a.role === 'researcher' && <p className="muted">A researcher uses the new model from its next run.</p>}
      {!modelEditable && <p className="muted">A {a.role} is started by Staff with the {a.role} role's model. Change that on the Models page.</p>}
    </details>
  );
}

const shq = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;

/** The command the Client runs to start an agent of this role with the configured model. */
// See STAFF_CLAUDE_SETTINGS in src/telemetry.ts: Staff compacts at about 280k tokens.
const STAFF_CLAUDE_SETTINGS = '{"autoCompactWindow":300000}';

function launchCommand(m: Json, name: string, prompt: string): string {
  if (m.runtime === 'codex') {
    // Same settings as the runner (src/codex-args.ts). Only staff and researcher run on Codex; another role gets no command.
    if (m.role !== 'staff' && m.role !== 'researcher') return `# The ${m.role} role does not run on Codex from here.`;
    return `codex exec --skip-git-repo-check ${codexRoleArgs(m.role).map(shq).join(' ')} -m ${m.model} -c 'model_reasoning_effort="${m.effort}"' ${shq(prompt)}`;
  }
  if (m.runtime === 'claude-code') return `claude --bg -n ${shq(name)}${m.role === 'staff' ? ` --settings ${shq(STAFF_CLAUDE_SETTINGS)}` : ''} --model ${m.model} --effort ${m.effort} ${shq(prompt)}`;
  return `# Start ${m.runtime} with model ${m.model} and effort ${m.effort}, then give it this prompt:\n${prompt}`;
}

function ResearchPage({ version }: { version: number }) {
  const { data, error, reload } = useData<Json>('/api/research', version);
  const act = useAction();
  const [form, setForm] = useState({ nickname: '', focus: '', repo_path: '', model: 'gpt-6.1-sol', effort: 'medium' });
  // New personas start with what the researcher role uses now, which follows the CLIs found on this machine.
  const roles = useData<Json>('/api/role-models', version);
  const researcherRole: Json | undefined = roles.data?.roles?.find((r: Json) => r.role === 'researcher');
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (researcherRole && !touched) setForm((f) => ({ ...f, model: researcherRole.model, effort: researcherRole.effort }));
  }, [researcherRole?.model, researcherRole?.effort, touched]);
  useEffect(() => {
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, []);
  const personas: Json[] = data?.personas ?? [];
  const nameOf = (id: string) => personas.find((p) => p.id === id)?.nickname ?? id;
  const b = data?.budget;
  const save = (id: string, patch: Json) => act.run(async () => (await post(`/api/research/personas/${id}`, patch, 'PUT'), reload()));
  return (
    <>
      <Section title="Codex budget">
        {!b ? (
          <p className="muted">No reading yet. It comes from the Codex transcripts, once a minute.</p>
        ) : (
          <>
            <p>
              5-hour window: <strong>{Number(b.used_now).toFixed(0)}%</strong> used{b.resets_at && <span className="muted"> · resets {fmt(b.resets_at)}</span>} · weekly:{' '}
              <strong>{b.weekly_used_percent ?? '?'}%</strong>{b.weekly_resets_at && <span className="muted"> · resets {fmt(b.weekly_resets_at)}</span>}
            </p>
            <div className="meter"><div style={{ width: `${Math.min(100, Number(b.used_now))}%` }} /></div>
            <p className="muted">
              Above {data.thresholds.urgent_only}% only questions and Client decisions start a run; above {data.thresholds.stop}% nothing does. Reading from <Ago ts={b.observed_at} />.
            </p>
          </>
        )}
      </Section>
      <Section title="Personas">
        {error && <p className="error">{error}</p>}
        {act.error && <p className="error">{act.error}</p>}
        <p className="muted">A persona has no running session. Triglav starts a short run when its inbox has work, through the runner (node scripts/runner.ts).</p>
        <table>
          <thead><tr><th>Name</th><th>Focus</th><th>Repository</th><th>Model</th><th>Effort</th><th>On</th></tr></thead>
          <tbody>
            {personas.map((p) => (
              <tr key={p.id} data-testid="persona">
                <td>{p.nickname}</td>
                <td>{p.focus}</td>
                <td className="muted">{p.repo_path}</td>
                <td><input aria-label={`${p.nickname} model`} defaultValue={p.model} onBlur={(e) => e.target.value !== p.model && save(p.id, { model: e.target.value })} /></td>
                <td>
                  <select aria-label={`${p.nickname} effort`} value={p.effort} onChange={(e) => save(p.id, { effort: e.target.value })}>
                    {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => <option key={x}>{x}</option>)}
                  </select>
                </td>
                <td><input type="checkbox" aria-label={`${p.nickname} enabled`} checked={!!p.enabled} onChange={(e) => save(p.id, { enabled: e.target.checked })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void act.run(async () => (await post('/api/research/personas', form), setForm({ ...form, nickname: '', focus: '' }), reload()));
          }}
        >
          <div className="row">
            <input placeholder="Name, for example sol-security" value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} />
            <input placeholder="Repository path" value={form.repo_path} onChange={(e) => setForm({ ...form, repo_path: e.target.value })} />
            <table>
              <tbody>
                <tr>
                  <ModelPicker
                    role="persona"
                    value={{ runtime: researcherRole?.runtime ?? 'codex', model: form.model, effort: form.effort }}
                    detected={roles.data?.detected ?? { runtimes: [] }}
                    runtimes={[researcherRole?.runtime ?? 'codex']}
                    onChange={(v) => (setTouched(true), setForm({ ...form, model: v.model, effort: v.effort }))}
                  />
                </tr>
              </tbody>
            </table>
          </div>
          {researcherRole && (
            <p className="muted" data-testid="persona-runtime">
              New personas run on {researcherRole.runtime}
              {researcherRole.replaces ? `, the only agent CLI the runner found on this machine (${researcherRole.replaces.runtime} is not installed)` : ''}.
            </p>
          )}
          <input placeholder="Focus, for example: sandboxing, IAM, Lambda security" value={form.focus} onChange={(e) => setForm({ ...form, focus: e.target.value })} />
          <button disabled={!form.nickname || !form.focus || act.busy}>Add persona</button>
        </form>
      </Section>
      <Section title="Inbox">
        {(data?.inbox ?? []).length === 0 ? (
          <p className="muted">Nothing routed yet.</p>
        ) : (
          <table>
            <thead><tr><th>Persona</th><th>Item</th><th>Status</th><th>Note</th><th>When</th></tr></thead>
            <tbody>
              {(data?.inbox ?? []).map((i: Json) => (
                <tr key={i.id} data-testid="inbox-item">
                  <td>{nameOf(i.persona_id)}</td>
                  <td>{i.thread_id ? <a href={`#/threads/${i.thread_id}`}>{i.title}</a> : i.title}</td>
                  <td><Pill value={i.status} kind="inbox" /></td>
                  <td className="muted">{i.note}</td>
                  <td><Ago ts={i.done_at ?? i.created_at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section title="Runs">
        {(data?.runs ?? []).length === 0 ? (
          <p className="muted">No runs yet.</p>
        ) : (
          <table>
            <thead><tr><th>Persona</th><th>Status</th><th>Started</th><th>Budget before</th><th>Result</th></tr></thead>
            <tbody>
              {(data?.runs ?? []).map((r: Json) => (
                <tr key={r.id}>
                  <td>{nameOf(r.persona_id)}</td>
                  <td><Pill value={r.status} kind="run" /></td>
                  <td><Ago ts={r.started_at ?? r.created_at} /></td>
                  <td>{r.budget_pct_before != null ? `${Number(r.budget_pct_before).toFixed(0)}%` : ''}</td>
                  <td className="muted"><pre className="text">{String(r.result ?? '').slice(0, 400)}</pre></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

type RoleValue = { runtime: string; model: string; effort: string };

/**
 * Runtime, model and effort for a role, as lists built from what the runner found on this machine, so a model is
 * chosen and never typed. Before the runner has listed a CLI's models, the model and effort are text fields as before.
 * `runtimes` limits the CLIs offered; one choice shows as text.
 */
function ModelPicker({ role, value, detected, onChange, runtimes }: { role: string; value: RoleValue; detected: Json; onChange: (v: RoleValue) => void; runtimes?: string[] }) {
  const cli: Json[] = detected.runtimes ?? [];
  const installed = cli.length ? cli.filter((r) => r.available).map((r) => r.runtime) : ['claude-code', 'codex'];
  const offered = [...new Set([...(runtimes ? runtimes.filter((r) => installed.includes(r)) : installed), value.runtime])];
  const catalog: Json[] = cli.find((r) => r.runtime === value.runtime)?.models ?? [];
  const current = catalog.find((m) => m.id === value.model);
  const efforts: string[] = current?.efforts ?? [];
  const pickEffort = (m: Json, want: string) => (m.efforts.includes(want) ? want : m.efforts.includes('high') ? 'high' : m.efforts[0]);
  const switchRuntime = (runtime: string) => {
    const first: Json | undefined = cli.find((r) => r.runtime === runtime)?.models?.[0];
    onChange(first ? { runtime, model: first.id, effort: pickEffort(first, value.effort) } : { ...value, runtime });
  };
  return (
    <>
      <td>
        {offered.length > 1 ? (
          <select aria-label={`${role} runtime`} value={value.runtime} onChange={(e) => switchRuntime(e.target.value)}>
            {offered.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        ) : (
          <span aria-label={`${role} runtime`}>{value.runtime}</span>
        )}
      </td>
      {catalog.length ? (
        <>
          <td>
            <select aria-label={`${role} model`} value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value, effort: pickEffort(catalog.find((m) => m.id === e.target.value)!, value.effort) })}>
              {!current && <option value={value.model}>{value.model} (not offered on this machine)</option>}
              {catalog.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </td>
          <td>
            <select aria-label={`${role} effort`} value={value.effort} onChange={(e) => onChange({ ...value, effort: e.target.value })}>
              {!efforts.includes(value.effort) && <option value={value.effort}>{value.effort}</option>}
              {efforts.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </td>
        </>
      ) : (
        <>
          <td>
            <input aria-label={`${role} model`} value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} />
          </td>
          <td>
            <input aria-label={`${role} effort`} value={value.effort} onChange={(e) => onChange({ ...value, effort: e.target.value })} />
          </td>
        </>
      )}
    </>
  );
}

const REVIEW_MODE_LABELS: Record<string, string> = {
  auto: 'Auto: use Copilot where the repository has it',
  copilot: 'Copilot required',
  ci_only: 'CI only, no Copilot review',
};
const REVIEW_MODE_NOTES: Record<string, string> = {
  auto: 'The Senior checks whether Copilot has reviewed recent PRs in the repository. If it has, the Senior runs the review loop. If not, delivery rests on green CI and says so.',
  copilot: 'A Senior cannot report delivery without a clean Copilot review. If Copilot does not answer, the Senior asks you.',
  ci_only: 'No Copilot review is requested. Delivery rests on green CI on the PR head commit, and says so.',
};

/** How a Senior reviews a PR before it reports delivery. Saved when changed, and read by Seniors from get_job. */
function ReviewModePicker({ mode, onSaved }: { mode: string; onSaved: () => void }) {
  const { error, busy, run } = useAction();
  return (
    <div data-testid="review-mode">
      <label className="field-label">
        Review before delivery
        <select aria-label="Review before delivery" value={mode} disabled={busy} onChange={(e) => void run(() => post('/api/review-mode', { mode: e.target.value }, 'PUT')).then((ok) => ok && onSaved())}>
          {Object.entries(REVIEW_MODE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">{REVIEW_MODE_NOTES[mode]}</p>
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

/** What the runner found on this machine, and what Triglav does about it. */
function DetectedRuntimes({ detected }: { detected: Json }) {
  const rows: Json[] = detected.runtimes ?? [];
  if (!rows.length) {
    return (
      <p className="muted" data-testid="detected-runtimes" data-known="false">
        Triglav has not checked this machine yet. The runner does it when it starts: <code>node scripts/runner.ts</code>. Until then both Claude Code and Codex are offered.
      </p>
    );
  }
  const present = rows.filter((r) => r.available);
  return (
    <div data-testid="detected-runtimes" data-known={String(detected.known)}>
      <p>
        Triglav's runner looked for agent CLIs on this machine and found{' '}
        <strong>{present.length ? present.map((r) => `${r.label}${r.version ? ` ${r.version}` : ''}`).join(' and ') : 'neither Claude Code nor Codex'}</strong>
        {rows.filter((r) => !r.available).map((r) => `, not ${r.label}`).join('')}. <span className="muted">Checked <Ago ts={detected.checked_at} />.</span>
      </p>
      {!detected.known && <p className="muted">That check is old, so the runner may be off. Nothing is switched until it reports again.</p>}
      {detected.known && present.length === 1 && <p className="muted">Only {present[0].label} is installed, so it is offered everywhere and used for any role saved for the other CLI.</p>}
      {detected.known && present.length === 0 && <p className="error">No agent CLI was found. Agents cannot start until one is installed and on the runner's PATH.</p>}
    </div>
  );
}

function ModelsPage({ version }: { version: number }) {
  const { data: view, error, reload } = useData<Json>('/api/role-models', version);
  const data: Json[] | undefined = view?.roles;
  const detected: Json = view?.detected ?? { runtimes: [], known: false };
  const [ticket, setTicket] = useState('');
  const [repo, setRepo] = useState('');
  // The agents' address from the server, not this page's origin: through the reverse proxy that origin has no /guide.md or /mcp.
  const base: string = view?.base_url ?? location.origin;
  const byRole = new Map((data ?? []).map((m) => [m.role, m]));
  const staff = byRole.get('staff');
  const t = ticket || '<TICKET>';
  return (
    <>
      <Section title="Model per role">
        <p className="muted">
          The orchestrator does not start agents. Seniors and reviewers get these settings in their spawn ticket, so a change applies to the next one Staff starts. Staff and researchers use the
          launch commands below. Running agents keep their model.
        </p>
        {error && <p className="error">{error}</p>}
        <DetectedRuntimes detected={detected} />
        <ReviewModePicker mode={view?.review_mode ?? 'auto'} onSaved={reload} />
        <table>
          <thead>
            <tr>
              <th>Role</th>
              <th>Runtime</th>
              <th>Model</th>
              <th>Effort</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((m) => (
              <ModelRow key={m.role} m={m} detected={detected} onSaved={reload} />
            ))}
          </tbody>
        </table>
      </Section>
      <ReviewPanelEditor version={version} detected={detected} />
      <Section title="Launch commands">
        <div className="composer">
          <div className="row">
            <input placeholder="Linear ticket, for example ENG-123" value={ticket} onChange={(e) => setTicket(e.target.value)} />
            <input placeholder="Repository path" value={repo} onChange={(e) => setRepo(e.target.value)} />
          </div>
        </div>
        {staff && (
          <>
            <h3>Staff</h3>
            <pre className="text" data-testid="launch-staff">
              {(repo ? `cd ${shq(repo)} && ` : '') +
                launchCommand(
                  staff,
                  `staff-${t.toLowerCase()}`,
                  `Call get_guide with role staff (or read ${base}/guide.md?role=staff) and follow it. Work on Linear ticket ${t} in repository ${repo || '<REPO>'}, base branch main.`,
                )}
            </pre>
          </>
        )}
      </Section>
    </>
  );
}

type PanelSeatValue = RoleValue;
type PanelDraft = { strong: PanelSeatValue & { count?: number }; cheap: PanelSeatValue[] };

/**
 * The local code review panel: one strong seat (run once or as up to four members) and up to four cheap seats, at most six seats in total. A review reads the saved panel when a Senior asks
 * for it, so a review that is already running keeps its seats. Models and efforts come from the runner's lists, like roles.
 */
function ReviewPanelEditor({ version, detected }: { version: number; detected: Json }) {
  const { data, error, reload } = useData<Json>('/api/review-panel', version);
  const [draft, setDraft] = useState<PanelDraft | null>(null);
  const { error: actionError, busy, run } = useAction();
  const saved: PanelDraft | undefined = data?.panel;
  const savedKey = JSON.stringify(saved ?? null);
  // Follow what the server holds, but only when it changed there, so an edit in progress is not overwritten by a refetch.
  useEffect(() => setDraft(saved ? (JSON.parse(savedKey) as PanelDraft) : null), [savedKey]);
  if (error) return <p className="error">{error}</p>;
  if (!data || !draft) return null;
  const dirty = JSON.stringify(draft) !== savedKey;
  const max: number = data.max_cheap_seats;
  const maxStrong: number = data.max_strong_count;
  const maxTotal: number = data.max_panel_seats;
  const count = draft.strong.count ?? 1;
  const total = count + draft.cheap.length;
  // A count of 1 is the plain seat: the key is left out, so a saved panel has one spelling and the draft compares equal to it.
  const setCount = (n: number) => {
    const { count: _old, ...rest } = draft.strong;
    setDraft({ ...draft, strong: n > 1 ? { ...rest, count: n } : rest });
  };
  const expected = expectedTokens(draft, data.averages ?? []);
  const seatsOf = (p: PanelDraft) => [{ label: 'strong seat', v: p.strong }, ...p.cheap.map((v, i) => ({ label: `cheap seat ${i + 1}`, v }))];
  // The picker returns a runtime, model and effort only, so the strong seat's count is put back.
  const setSeat = (i: number, v: PanelSeatValue) => setDraft(i === 0 ? { ...draft, strong: draft.strong.count ? { ...v, count: draft.strong.count } : v } : { ...draft, cheap: draft.cheap.map((c, k) => (k === i - 1 ? v : c)) });
  const save = () => run(() => post('/api/review-panel', draft, 'PUT')).then((ok) => ok && reload());
  // The draft comes from the reset answer: when the server already held the default, nothing changes there and the effect that follows it does not run.
  const reset = () =>
    run(async () => {
      const view = await post<Json>('/api/review-panel/reset', {});
      setDraft(view.panel);
      reload();
    });
  return (
    <Section title="Review panel">
      <div data-testid="review-panel" data-default={String(data.is_default)}>
        <p className="muted">
          Before a Senior pushes, a panel of read-only reviewers reads its diff. The strong seat is the main reviewer; the cheap seats add a second look at low cost. A review takes the panel as it is saved when the Senior asks for it, so a review that
          is already running keeps its seats. If a CLI is missing, or Codex is at its budget stop, a seat runs on the other CLI and the round says so.
        </p>
        <p className="muted" data-testid="review-panel-state">
          {data.is_default ? 'This is the default panel.' : <>Saved panel, changed <Ago ts={data.updated_at} />.</>}
        </p>
        <table>
          <thead>
            <tr>
              <th>Seat</th>
              <th>Runtime</th>
              <th>Model</th>
              <th>Effort</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {seatsOf(draft).map(({ label, v }, i) => (
              <tr key={label} data-testid="review-panel-seat" data-seat={label}>
                <td>{label}</td>
                <ModelPicker role={label} value={v} detected={detected} onChange={(nv) => setSeat(i, nv)} />
                <td className="actions">
                  {i === 0 && (
                    <label>
                      Members{' '}
                      <select aria-label="strong seat count" value={count} disabled={busy} onChange={(e) => setCount(Number(e.target.value))}>
                        {Array.from({ length: maxStrong }, (_, k) => k + 1).map((n) => (
                          <option key={n} value={n} disabled={n + draft.cheap.length > maxTotal}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {i > 0 && (
                    <button disabled={busy} aria-label={`remove ${label}`} onClick={() => setDraft({ ...draft, cheap: draft.cheap.filter((_, k) => k !== i - 1) })}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" data-testid="review-panel-members">
          {count > 1 ? `The strong seat runs ${count} times, as ${panelSeatNames(count)}. ` : 'The strong seat runs once. A higher count runs the same model again for a second look, at the cost of more tokens. '}
          The panel starts {total} of at most {maxTotal} seats.
        </p>
        <p className="muted" data-testid="review-panel-expected" data-in={expected.tokens_in} data-unknown={expected.unknown}>
          {expected.unknown === expected.seats
            ? 'No finished review run has reported tokens for these seats yet, so there is no estimate.'
            : `Expected per review: about ${fmtTokens(expected.tokens_in)} input tokens and ${fmtTokens(expected.tokens_out)} output tokens, from the average of finished seat runs of the same model.`}
          {expected.repeated > 0 && ` ${expected.repeated} cheap seat(s) repeat another cheap seat and do not run, so they are not counted.`}
          {expected.unknown > 0 && expected.unknown < expected.seats && ` ${expected.unknown} of ${expected.seats} seats have no finished run yet and are left out.`} Input includes cached tokens. The estimate uses the seats as configured: a seat that moves to the other CLI, or that is dropped as a repeat of a strong member, is not predicted. Runs of every round are averaged, so a small fix round lowers the number.
        </p>
        <div className="actions">
          <button disabled={busy || draft.cheap.length >= max || total >= maxTotal} onClick={() => setDraft({ ...draft, cheap: [...draft.cheap, { ...(data.default_panel.cheap[0] ?? data.default_panel.strong) }] })}>
            Add a cheap seat
          </button>
          <button disabled={!dirty || busy} onClick={save}>
            Save panel
          </button>
          <button disabled={busy || (data.is_default && !dirty)} onClick={reset}>
            Reset to default
          </button>
          {draft.cheap.length >= max && <span className="muted">At most {max} cheap seats.</span>}
          {draft.cheap.length < max && total >= maxTotal && <span className="muted">At most {maxTotal} seats in total.</span>}
        </div>
        {actionError && <p className="error">{actionError}</p>}
      </div>
    </Section>
  );
}

const panelSeatNames = (n: number) => ['strong', ...Array.from({ length: n - 1 }, (_, i) => `strong-${i + 2}`)].join(', ');

const secs = (n: number | null | undefined) => (n === null || n === undefined ? 'n/a' : n >= 120 ? `${Math.round(n / 60)} min` : `${Math.round(n)} s`);
const tok = (n: number | null | undefined) => (n === null || n === undefined ? 'n/a' : fmtTokens(n));

/**
 * The local review rounds and the Copilot rounds of a job. Every string from a reviewer or a Senior (titles, bodies, sites,
 * triage reasons, seat notes, failures) is shown as plain text: no markdown, no links, no HTML.
 */
/** Every PR that went through the local review, newest first. Observe only: nothing here changes a review. */
function ReviewsPage({ version, names, focus }: { version: number; names: Names; focus?: string }) {
  const { data, error } = useData<Json[]>('/api/reviews', version);
  const [open, setOpen] = useState<string | null>(focus ?? null);
  return (
    <Section title="Reviews">
      <p className="muted">
        Every change an agent sends for review is read by a panel of reviewer models before the PR goes further. This page shows what they found and how the Senior answered each finding. A finding is <strong>disputed</strong> when the Senior said it is debatable or wrong instead of fixing it. Click a row to read the rounds.
      </p>
      {error && <p className="error">{error}</p>}
      {data && data.length === 0 && <p className="muted">No reviews yet.</p>}
      {data && data.length > 0 && (
        <table data-testid="reviews-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>PR</th>
              <th>Local rounds</th>
              <th>Last verdict</th>
              <th>Findings</th>
              <th>Copilot rounds</th>
              <th>Job status</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <Fragment key={r.job_id}>
                <tr className="clickable" data-testid="reviews-row" data-job-id={r.job_id} data-disputed={r.disputed} onClick={() => setOpen(open === r.job_id ? null : r.job_id)}>
                  <td>
                    {open === r.job_id ? '▾' : '▸'} <a href={`#/jobs/${r.job_id}`} onClick={(e) => e.stopPropagation()}>{r.linear_identifier}</a> {r.title}
                  </td>
                  <td>{/^https?:\/\//.test(r.pr_url ?? '') ? <a href={r.pr_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{prLabel(r.pr_url)}</a> : <span className="muted">no PR yet</span>}</td>
                  <td>
                    {r.local_rounds}
                    {r.failed_reviews > 0 && <span className="muted"> ({r.failed_reviews} failed)</span>}
                    {r.running > 0 && <span className="attention"> · running</span>}
                  </td>
                  <td>{r.last_verdict ?? <span className="muted">none yet</span>}</td>
                  <td>
                    {r.findings}
                    {r.findings > 0 && <span className="muted"> · {r.accepted} accepted</span>}
                    {r.disputed > 0 && <span className="attention" data-testid="reviews-disputed"> · {r.disputed} disputed</span>}
                  </td>
                  <td>{r.copilot_rounds}</td>
                  <td><Pill value={r.job_status} /></td>
                  <td><Ago ts={r.last_at} /></td>
                </tr>
                {open === r.job_id && (
                  <tr>
                    <td colSpan={8}>
                      <ReviewRounds jobId={r.job_id} version={version} names={names} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

const prLabel = (url: string) => {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[1]}#${m[2]}` : url;
};

/** The rounds of one job as a short conversation: what the reviewers found, how the Senior answered. Plain text only. */
function ReviewRounds({ jobId, version, names }: { jobId: string; version: number; names: Names }) {
  const { data, error } = useData<Json>(`/api/jobs/${jobId}/reviews`, version);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading.</p>;
  return (
    <div data-testid="review-rounds">
      {data.local.map((r: Json) => (
        <div key={r.review_id} className="card" data-testid="review-round" data-status={r.status}>
          <p>
            <strong>Round {r.round}</strong> · <code>{r.base_sha.slice(0, 8)}..{r.head_sha.slice(0, 8)}</code> ·{' '}
            {r.status === 'running' ? 'reviewers are reading it now' : r.status === 'failed' ? <span className="error">did not finish, does not count</span> : <>verdict <strong>{r.verdict}</strong></>} ·{' '}
            <span className="muted">
              read by {r.seats.map((s: Json) => s.model).join(' and ')} · <Ago ts={r.created_at} />
            </span>
          </p>
          {r.failure && <p className="muted">{r.failure}</p>}
          {r.status !== 'running' && r.findings.length === 0 && <p className="muted">The reviewers found nothing to change.</p>}
          {r.findings.map((f: Json) => {
            const disputed = ['P0', 'P1', 'P2'].includes(f.severity) && (f.triage === 'debatable' || f.triage === 'invalid');
            return (
              <div key={f.finding_id} className={`review-finding${disputed ? ' disputed' : ''}`} data-testid="round-finding" data-disputed={String(disputed)}>
                <p>
                  <strong>{f.severity}</strong> {f.title}{' '}
                  <span className="muted">
                    · {f.reviewer_count === 1 ? '1 reviewer' : `${f.reviewer_count} reviewers`}
                    {f.sites.length > 0 && <> · {f.sites.slice(0, 3).map((x: Json) => `${x.file}:${x.line}`).join(', ')}{f.sites.length > 3 ? ` and ${f.sites.length - 3} more` : ''}</>}
                  </span>
                </p>
                <details>
                  <summary className="muted">What the reviewer wrote</summary>
                  <pre className="text">{f.body}</pre>
                </details>
                <p className="review-answer">
                  {f.triage === null ? (
                    <span className="muted">{f.severity === 'P3' ? 'Not answered. A P3 never blocks.' : 'Not answered yet.'}</span>
                  ) : (
                    <>
                      <Who id={f.triaged_by} names={names} />{' '}
                      {f.triage === 'valid' ? 'accepted it' : disputed ? <strong className="attention">disputed it as {f.triage}</strong> : `answered ${f.triage}`}
                      {f.triage_reason ? <>: <span>{f.triage_reason}</span></> : null}
                    </>
                  )}
                </p>
              </div>
            );
          })}
        </div>
      ))}
      {data.copilot.map((c: Json) => (
        <div key={`${c.pr}-${c.round}`} className="card" data-testid="review-copilot-round">
          <p>
            <strong>Copilot round {c.round}</strong> on PR #{c.pr} · <code>{c.head_sha.slice(0, 8)}</code> ·{' '}
            {c.approval_recommended === null ? <span className="muted">result not recorded yet</span> : <>{c.approval_recommended ? 'approval recommended' : 'changes recommended'} · P0 {c.p0} · P1 {c.p1} · P2 {c.p2} · P3 {c.p3}{c.previously_missed ? ` · ${c.previously_missed} previously missed` : ''}</>}
          </p>
        </div>
      ))}
      <p className="muted">
        Seats, tokens and cost of each round are on the <a href={`#/jobs/${jobId}`}>job page</a>.
      </p>
    </div>
  );
}

function CodeReviews({ jobId, version }: { jobId: string; version: number }) {
  const { data } = useData<Json>(`/api/jobs/${jobId}/reviews`, version);
  if (!data || (data.local.length === 0 && data.copilot.length === 0)) return null;
  return (
    <Section title="Local code review and Copilot rounds">
      <div data-testid="code-reviews">
        {data.local.map((r: Json) => (
          <div key={r.review_id} className="card" data-testid="local-review" data-status={r.status} data-verdict={r.verdict ?? ''}>
            <p>
              <strong>Round {r.round}</strong> · <code>{r.base_sha.slice(0, 8)}..{r.head_sha.slice(0, 8)}</code> · {r.status === 'running' ? 'running' : r.status === 'failed' ? <span className="error">failed</span> : <>verdict <strong>{r.verdict}</strong></>} · {secs(r.wall_secs)} · <span className="muted">requested <Ago ts={r.created_at} /></span>
            </p>
            {r.failure && <p className="error" data-testid="review-failure">{r.failure}</p>}
            {r.incomplete && (
              <div className="card attention-card" data-testid="review-incomplete">
                <p className="attention">Some reviewer output could not be used. This round may be missing findings.</p>
                <p className="muted">The verdict counts only the findings that could be read. A finding with no valid site is listed below and still counts.</p>
                <ul>
                  {r.incomplete.seats.map((x: Json) => (
                    <li key={x.seat} data-testid="incomplete-seat" data-seat={x.seat}>
                      {x.seat}: {x.rejected} {x.rejected === 1 ? 'entry' : 'entries'} rejected by the parser, {x.zero_site} {x.zero_site === 1 ? 'finding' : 'findings'} with no valid site
                    </li>
                  ))}
                </ul>
                {r.incomplete.zero_site_findings.length > 0 && (
                  <>
                    <p className="muted">Findings with no valid site:</p>
                    <ul data-testid="zero-site-findings">
                      {r.incomplete.zero_site_findings.map((z: Json) => (
                        <li key={`${z.seat}-${z.index}`} data-testid="zero-site-finding">
                          {z.seat} #{z.index} <strong>{z.severity}</strong> {z.title}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
            {r.rules?.changed?.length > 0 && (
              <p className="attention" data-testid="review-rules-changed">
                This change edits rule files of the repository: {r.rules.changed.join(', ')}
                {r.rules.changed_more ? ` and ${r.rules.changed_more} more` : ''}. The reviewers were given the rules from before the change and were asked to review these edits as code.
              </p>
            )}
            {r.rules && (
              <div data-testid="review-rules">
                <p className="muted">
                  Repository rules read at <code>{r.rules.commit.slice(0, 12)}</code> ({r.rules.source === 'origin' ? 'merge base with origin' : r.rules.source === 'local' ? 'merge base with the local base branch, origin was not usable' : r.rules.source === 'base_sha' ? 'the base commit of this round, no merge base was usable; from round 2 on it already holds the earlier rounds\' rule edits' : r.rules.source}):{' '}
                  {r.rules.files.length === 0
                    ? 'no rule files'
                    : r.rules.files.map((f: Json) => `${f.path} (${f.kind}${f.same_as ? `, same as ${f.same_as}` : `, ${f.chars} chars`}${f.cut ? ', cut' : ''})`).join(', ')}
                  .
                </p>
                {(r.rules.omitted.length > 0 || r.rules.omitted_more > 0) && (
                  <p className="attention" data-testid="review-rules-omitted">
                    Left out for the rules budget or for size (over 1 MB): {r.rules.omitted.join(', ')}
                    {r.rules.omitted_more ? ` and ${r.rules.omitted_more} more` : ''}.
                  </p>
                )}
              </div>
            )}
            {r.same_family_note && (
              <p className="attention" data-testid="same-family">
                {r.same_family_note}
              </p>
            )}
            <table>
              <thead>
                <tr>
                  <th>Seat</th>
                  <th>Runtime</th>
                  <th>Family</th>
                  <th>Requested</th>
                  <th>Model</th>
                  <th>Effort</th>
                  <th>Status</th>
                  <th>Rejected</th>
                  <th>No site</th>
                  <th>Time</th>
                  <th>Tokens in / cached / out</th>
                </tr>
              </thead>
              <tbody>
                {r.seats.map((s: Json) => (
                  <Fragment key={s.seat}>
                    <tr data-testid="review-seat" data-seat={s.seat}>
                      <td>{s.seat}</td>
                      <td>{s.runtime}</td>
                      <td>{s.family}</td>
                      <td data-testid="seat-requested">
                        {s.requested ? (
                          <span className={s.requested.runtime !== s.runtime || s.requested.model !== s.model || s.requested.effort !== s.effort ? 'attention' : undefined}>
                            {s.requested.runtime} {s.requested.model} {s.requested.effort}
                          </span>
                        ) : (
                          <span className="muted">not recorded</span>
                        )}
                      </td>
                      <td>{s.model}</td>
                      <td>{s.effort}</td>
                      <td>{s.status}</td>
                      <td data-testid="seat-rejected">{s.rejected ?? 0}</td>
                      <td data-testid="seat-zero-site">{s.zero_site ?? 0}</td>
                      <td>{secs(s.secs)}</td>
                      <td>
                        {tok(s.tokens.in)} / {tok(s.tokens.cached)} / {tok(s.tokens.out)}
                      </td>
                    </tr>
                    {(s.note || s.error) && (
                      <tr>
                        <td colSpan={11} className="muted">
                          {s.seat}: {s.note}
                          {s.error ? ` ${s.error}` : ''}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {r.dropped_seats.length > 0 && (
              <ul data-testid="dropped-seats">
                {r.dropped_seats.map((d: Json) => (
                  <li key={d.seat} className="muted">
                    Seat {d.seat} did not run: {d.reason}
                  </li>
                ))}
              </ul>
            )}
            {r.resolved?.length > 0 && (
              <div data-testid="review-resolved">
                <p className="muted">What the reviewers said about the findings of the previous round (their opinion; your triage decides):</p>
                <ul>
                  {r.resolved.map((x: Json) => (
                    <li key={x.finding_id} data-testid="review-resolved-item" data-status={x.status}>
                      {x.severity ?? ''} {x.title ?? x.finding_id}: <strong>{x.status === 'fixed' ? 'fixed' : x.status === 'not_fixed' ? 'not fixed' : 'unknown'}</strong>
                      <span className="muted">
                        {' '}
                        · fixed by {x.fixed_by.length ? x.fixed_by.join(', ') : 'none'} · not fixed by {x.not_fixed_by.length ? x.not_fixed_by.join(', ') : 'none'}
                        {x.unknown_by?.length ? ` · unknown to ${x.unknown_by.join(', ')}` : ''}
                        {x.silent?.length ? ` · no answer from ${x.silent.join(', ')}` : ''}
                        {x.sites.length > 0 ? ` · ${x.sites.map((y: Json) => `${y.file}:${y.line}`).join(', ')}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
                {r.seats.some((s: Json) => s.resolved_dropped > 0) && (
                  <p className="muted" data-testid="resolved-dropped">
                    Answers dropped as invalid (an id that was not asked, a bad status or a repeated id):{' '}
                    {r.seats
                      .filter((s: Json) => s.resolved_dropped > 0)
                      .map((s: Json) => `${s.seat} ${s.resolved_dropped}`)
                      .join(', ')}
                  </p>
                )}
              </div>
            )}
            {r.findings.length === 0 ? (
              <p className="muted">No findings{r.rejected_findings ? ` (${r.rejected_findings} reviewer entries were not valid findings)` : ''}.</p>
            ) : (
              <ul data-testid="review-findings">
                {r.findings.map((f: Json) => (
                  <li key={f.finding_id} data-testid="review-finding" data-severity={f.severity} data-blocking={String(r.blocking.includes(f.finding_id))}>
                    <strong>{f.severity}</strong> {f.title} <span className="muted">· {f.reviewer_count} {f.reviewer_count === 1 ? 'reviewer' : 'reviewers'} ({f.reviewers.join(', ')})</span>
                    {r.blocking.includes(f.finding_id) && <span className="attention"> · blocks</span>}
                    <pre className="text">{f.body}</pre>
                    {f.sites.length > 0 && (
                      <p className="muted">
                        {f.sites.map((x: Json) => `${x.file}:${x.line}`).join(', ')}
                        {f.omitted_sites > 0 && <span data-testid="omitted-sites"> and {f.omitted_sites} more {f.omitted_sites === 1 ? 'site' : 'sites'} not kept</span>}
                      </p>
                    )}
                    {f.sources?.length > 0 && (
                      <details data-testid="finding-sources">
                        <summary className="muted">
                          {f.sources.length} {f.sources.length === 1 ? 'report' : 'reports'} as each seat wrote it
                        </summary>
                        <ul>
                          {f.sources.map((src: Json, i: number) => (
                            <li key={i} data-testid="finding-source" data-seat={src.seat}>
                              {src.seat} #{src.index ?? '?'} <strong>{src.severity}</strong> {src.title ?? '(text not stored)'}
                              {src.body && <pre className="text">{src.body}</pre>}
                              {src.sites.length > 0 && <p className="muted">{src.sites.map((x: Json) => `${x.file}:${x.line}`).join(', ')}</p>}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {f.outside_delta !== null && f.outside_delta !== undefined && (
                      <p className="muted" data-testid="outside-delta" data-outside={String(f.outside_delta)}>
                        {f.outside_delta ? 'Location: no site is on a line this round changed (a location label only, not proof that the problem was already there).' : 'Location: a site is on a line this round changed.'}
                      </p>
                    )}
                    <p className="muted">{f.triage ? `Triage: ${f.triage}. ${f.triage_reason ?? ''}` : 'Not triaged'}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {data.copilot.length > 0 && (
          <table data-testid="copilot-rounds">
            <thead>
              <tr>
                <th>PR</th>
                <th>Copilot round</th>
                <th>Head</th>
                <th>Approval recommended</th>
                <th>P0</th>
                <th>P1</th>
                <th>P2</th>
                <th>P3</th>
                <th>Previously missed</th>
              </tr>
            </thead>
            <tbody>
              {data.copilot.map((c: Json) => (
                <tr key={`${c.pr}-${c.round}`} data-testid="copilot-round">
                  <td>#{c.pr}</td>
                  <td>{c.round}</td>
                  <td>
                    <code>{c.head_sha.slice(0, 8)}</code>
                  </td>
                  <td>{c.approval_recommended === null ? 'result not recorded yet' : c.approval_recommended ? 'yes' : 'no'}</td>
                  <td>{c.p0 ?? 'n/a'}</td>
                  <td>{c.p1 ?? 'n/a'}</td>
                  <td>{c.p2 ?? 'n/a'}</td>
                  <td>{c.p3 ?? 'n/a'}</td>
                  <td>{c.previously_missed ?? 'n/a'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Section>
  );
}

function ModelRow({ m: shown, detected, onSaved }: { m: Json; detected: Json; onSaved: () => void }) {
  // `shown` is what Triglav uses now. Where the saved CLI is not installed it replaces the saved setting, which is in `replaces`.
  const m: Json = shown.replaces ? { ...shown, ...shown.replaces } : shown;
  const [v, setV] = useState<RoleValue>({ runtime: m.runtime, model: m.model, effort: m.effort });
  // Follow changes saved elsewhere, but leave the fields alone while nothing changed on the server.
  useEffect(() => setV({ runtime: m.runtime, model: m.model, effort: m.effort }), [m.runtime, m.model, m.effort]);
  const { error, busy, run } = useAction();
  const dirty = v.runtime !== m.runtime || v.model !== m.model || v.effort !== m.effort;
  return (
    <tr data-testid="role-model" data-role={m.role}>
      <td>{m.role}</td>
      <ModelPicker role={m.role} value={v} detected={detected} onChange={setV} />
      <td className="actions">
        <button disabled={!dirty || busy} onClick={() => run(() => post(`/api/role-models/${m.role}`, v, 'PUT')).then((ok) => ok && onSaved())}>
          Save
        </button>
        <span className="muted">updated {fmt(m.updated_at)}</span>
        {shown.replaces && (
          <span className="muted" data-testid="role-replaced">
            {m.runtime} is not on this machine, so Triglav uses {shown.runtime} {shown.model} {shown.effort}.{' '}
            <button className="link" disabled={busy} onClick={() => run(() => post(`/api/role-models/${m.role}`, { runtime: shown.runtime, model: shown.model, effort: shown.effort }, 'PUT')).then((ok) => ok && onSaved())}>
              Save this
            </button>
          </span>
        )}
        {error && <span className="error">{error}</span>}
      </td>
    </tr>
  );
}

function BoardPage({ version, names }: { version: number; names: Names }) {
  const { data, error } = useData<Json[]>('/api/board', version);
  return (
    <Section title="Board, all jobs">
      {error && <p className="error">{error}</p>}
      <table>
        <tbody>
          {(data ?? []).map((t) => (
            <tr key={t.thread_id}>
              <td>
                <a href={`#/jobs/${t.job_id}`}>{t.linear_identifier}</a>
              </td>
              <td>
                <a href={`#/threads/${t.thread_id}`}>{t.title}</a> <span className="muted">{t.kind}</span>
              </td>
              <td>{t.question_state && <Pill value={t.question_state} kind="q" />}</td>
              <td>{t.asker && <Who id={t.asker} names={names} />}</td>
              <td className="muted">{t.messages} messages</td>
              <td className="muted">{fmt(t.last_message_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/* ---------- Home: live map ---------- */

/*
 * The map is laid out in pixels, left to right: Triglav, then each Staff with its jobs, the Seniors on them, Copilot and the PR.
 * Every node has a fixed size and its own slot, so nothing overlaps. The whole map is scaled to fit the window (useFit).
 */
const COL = { center: 0, staff: 1, job: 2, worker: 3, copilot: 4, pr: 5 } as const;
const COL_W = [96, 176, 176, 150, 128, 112];
const SIZE: Record<MapNode['kind'], [number, number]> = {
  center: [96, 96],
  staff: [176, 46],
  job: [176, 46],
  worker: [150, 46],
  researcher: [176, 46],
  copilot: [128, 46],
  pr: [112, 34],
};
const GAP = 56;
const PAD = 28;
const ROW = 62;
const LANE_GAP = 26;
const MIN_HEIGHT = 260;
const COL_X = COL_W.map((w, i) => PAD + COL_W.slice(0, i).reduce((sum, c) => sum + c + GAP, 0) + w / 2);
const MAP_W = COL_X[COL_X.length - 1] + COL_W[COL_W.length - 1] / 2 + PAD;

interface MapNode {
  key: string;
  kind: 'center' | 'staff' | 'worker' | 'researcher' | 'job' | 'pr' | 'copilot';
  external?: boolean;
  working?: boolean;
  x: number;
  y: number;
  label: string;
  sub?: string;
  href: string;
  status?: string;
  /** A job that cannot go on until someone acts. */
  blocked?: boolean;
  card: { title: string; lines: [string, string][]; waiting?: { kind: string; text: string; href: string }[]; links?: { label: string; href: string; external?: boolean }[] };
}

type Edge = { from: string; to: string; presence?: string; arrow?: boolean; active?: boolean; pulse?: boolean };

/** A block of rows for one Staff. A node takes a slot (column, row); positions are set once every block has its final size. */
interface Lane {
  rows: Set<number>[];
  members: { node: MapNode; col: number; row: number }[];
}

function layout(agents: Json[], jobs: Json[], blockers: Json[], extras: Json | null) {
  const live = agents.filter((a) => a.presence !== 'ended' && a.presence !== 'offline');
  const staff = live.filter((a) => a.role === 'staff');
  const workers = live.filter((a) => a.role === 'senior' || a.role === 'reviewer');
  const researchers = live.filter((a) => a.role === 'researcher');
  const openJobs = jobs.filter((j) => !j.parent_job_id && !['done', 'cancelled'].includes(j.status));
  const hub: MapNode = { key: 'center', kind: 'center', x: 0, y: 0, label: 'Triglav', href: '#/jobs', card: { title: 'Triglav', lines: [['Staff', String(staff.length)], ['Workers', String(workers.length)], ['Open jobs', String(openJobs.length)]] } };
  const nodes: MapNode[] = [hub];
  const edges: Edge[] = [];
  const lanes: { lane: Lane; staff?: MapNode }[] = [];
  const prs: Json[] = extras?.prs ?? [];
  const waiting = new Map<string, string>((extras?.copilot_waiting ?? []).map((w: Json) => [w.agent_id, w.since]));
  const shown = new Set<string>(openJobs.map((j) => j.id));
  // The jobs a worker holds, as the top-level jobs they belong to.
  const targetsOf = (w: Json): string[] => (w.held ?? []).map((h: Json) => jobs.find((j) => j.id === h.job_id)?.parent_job_id ?? h.job_id);
  /** Puts a node in `row` of the lane, or in a new row at the bottom when that slot is taken. Returns the row used. */
  const put = (lane: Lane, col: number, row: number, node: MapNode) => {
    const r = lane.rows[row]?.has(col) ? lane.rows.length : row;
    (lane.rows[r] ??= new Set()).add(col);
    lane.members.push({ node, col, row: r });
    nodes.push(node);
    return r;
  };
  const prNode = (pr: Json, key: string): MapNode => ({ key, kind: 'pr', x: 0, y: 0, label: `PR #${pr.label.split('#').pop()}`, href: `${pr.url}/files`, external: true, card: { title: pr.label, lines: [['Opens', 'Files changed on GitHub']] } });
  // What the job's hover card links to: the Client decisions open on it (or on one of its subjobs), its PR and its Staff.
  const jobFacts = (j: Json): JobFacts => ({
    blockers: blockers.filter((b) => b.job_id === j.id || jobs.find((x) => x.id === b.job_id)?.parent_job_id === j.id),
    pr: prs.find((p) => p.job_id === j.id),
    staff: agents.find((s) => s.id === j.staff_agent_id),
  });
  // A job whose Staff is not active still shows, attached to the centre.
  const orphanJobs = openJobs.filter((j) => !staff.some((s) => s.id === j.staff_agent_id));

  for (const s of staff) {
    const lane: Lane = { rows: [], members: [] };
    const staffNode: MapNode = { key: s.id, kind: 'staff', x: 0, y: 0, label: s.nickname, sub: 'Staff', href: `#/agents/${s.id}`, status: s.presence, card: agentCard(s) };
    nodes.push(staffNode);
    lanes.push({ lane, staff: staffNode });
    edges.push({ from: 'center', to: s.id, presence: s.presence, arrow: true });
    // One row per job. Its Senior, Copilot and PR sit on the same row.
    const jobRow = new Map<string, number>();
    for (const j of openJobs.filter((x) => x.staff_agent_id === s.id)) {
      const row = put(lane, COL.job, lane.rows.length, jobNode(j, jobFacts(j)));
      jobRow.set(j.id, row);
      edges.push({ from: s.id, to: `job-${j.id}`, arrow: true });
      // A PR with nobody working on it hangs off its job.
      const pr = prs.find((p) => p.job_id === j.id);
      if (pr && !workers.some((w) => targetsOf(w).includes(j.id))) {
        put(lane, COL.pr, row, prNode(pr, `pr-${j.id}`));
        edges.push({ from: `pr-${j.id}`, to: `job-${j.id}`, arrow: true });
      }
    }
    for (const w of workers.filter((x) => x.parent_agent_id === s.id)) {
      // A worker on one of these jobs sits on its row and reaches Staff through the job; an idle one gets its own row.
      const anchor = targetsOf(w).find((t) => jobRow.has(t));
      const row = put(lane, COL.worker, anchor === undefined ? lane.rows.length : jobRow.get(anchor)!, { key: w.id, kind: 'worker', x: 0, y: 0, label: w.nickname, sub: w.role, href: `#/agents/${w.id}`, status: w.presence, card: agentCard(w) });
      if (anchor === undefined) edges.push({ from: s.id, to: w.id, presence: w.presence, arrow: true });
      for (const h of w.held ?? []) {
        const job = jobs.find((j) => j.id === h.job_id);
        const target = job?.parent_job_id ?? h.job_id;
        if (shown.has(target)) edges.push({ from: w.id, to: `job-${target}`, presence: w.presence, arrow: true });
        // The PR of the child job the worker holds, else the parent's.
        const pr = prs.find((p) => p.own_job_id === h.job_id) ?? prs.find((p) => p.job_id === target);
        if (!pr) continue;
        const prKey = `pr-${pr.own_job_id ?? pr.job_id}`;
        const hasPr = nodes.some((n) => n.key === prKey);
        if (!hasPr) put(lane, COL.pr, row, prNode(pr, prKey));
        // Copilot shows only while it is reviewing; when the review lands the Senior picks the work back up.
        const key = `copilot-${w.id}`;
        if (waiting.has(w.id)) {
          if (!nodes.some((n) => n.key === key)) {
            const since = waiting.get(w.id);
            put(lane, COL.copilot, row, {
              key,
              kind: 'copilot',
              x: 0,
              y: 0,
              label: 'Copilot',
              sub: 'reviewing',
              href: pr.url,
              external: true,
              status: 'waiting',
              working: true,
              card: { title: `Copilot review on ${pr.label}`, lines: [['State', `${w.nickname} is waiting for a review`], ...(since ? [['Since', fmt(since)] as [string, string]] : []), ['Opens', 'The PR conversation, where reviews land']] },
            });
            edges.push({ from: w.id, to: key, arrow: true, active: true });
            edges.push({ from: key, to: prKey, arrow: true, active: true });
          }
        } else if (!hasPr) {
          edges.push({ from: w.id, to: prKey, presence: w.presence });
        }
      }
    }
  }
  // Jobs without a Staff and the researchers take the last block, in the Staff column, each linked to the centre.
  const rest: Lane = { rows: [], members: [] };
  for (const j of orphanJobs) {
    put(rest, COL.staff, rest.rows.length, jobNode(j, jobFacts(j)));
    edges.push({ from: 'center', to: `job-${j.id}`, presence: 'offline' });
  }
  for (const r of researchers) {
    put(rest, COL.staff, rest.rows.length, { key: r.id, kind: 'researcher', x: 0, y: 0, label: r.nickname, sub: 'Researcher', href: `#/agents/${r.id}`, status: r.presence, card: agentCard(r) });
    edges.push({ from: 'center', to: r.id, presence: r.presence });
  }
  if (rest.members.length) lanes.push({ lane: rest });

  let top = PAD;
  for (const { lane, staff: head } of lanes) {
    const height = Math.max(lane.rows.length, 1) * ROW;
    for (const m of lane.members) {
      m.node.x = COL_X[m.col];
      m.node.y = top + m.row * ROW + ROW / 2;
    }
    if (head) {
      head.x = COL_X[COL.staff];
      head.y = top + height / 2;
    }
    top += height + LANE_GAP;
  }
  const height = Math.max(top - LANE_GAP + PAD, MIN_HEIGHT);
  hub.x = lanes.length ? COL_X[COL.center] : MAP_W / 2;
  hub.y = height / 2;

  // Working: calling tools right now. Waiting on the board or on Copilot is not working.
  for (const n of nodes) {
    if (n.kind === 'staff' || n.kind === 'worker' || n.kind === 'researcher') n.working = (n.status === 'active' || n.status === 'working') && !waiting.has(n.key);
  }
  // A working agent's arrows to its jobs and PRs pulse, so the map shows what it is working on.
  const kinds = new Map(nodes.map((n) => [n.key, n]));
  for (const e of edges) {
    const target = kinds.get(e.to)?.kind;
    if (kinds.get(e.from)?.working && (target === 'job' || target === 'pr')) e.pulse = true;
  }
  return { nodes, edges, height };
}

/** Scales the map down (or up a little) to the width of its box and the height of the window. */
function useFit(height: number) {
  const box = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setZoom(Math.max(0.5, Math.min(1.4, el.clientWidth / MAP_W, (innerHeight - 90) / height)));
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    addEventListener('resize', fit);
    return () => {
      watch.disconnect();
      removeEventListener('resize', fit);
    };
  }, [height]);
  return [box, zoom] as const;
}

function agentCard(a: Json): MapNode['card'] {
  return {
    title: a.nickname,
    lines: [
      ['Role', a.role],
      ['Model', a.model ?? a.runtime],
      ...(a.effort ? [['Effort', a.effort] as [string, string]] : []),
      ['Presence', a.presence],
      ...(a.focus ? [['Focus', a.focus] as [string, string]] : []),
      ...(a.held?.length ? [['Holds', a.held.map((h: Json) => `${h.kind} #${h.attempt}`).join(', ')] as [string, string]] : []),
    ],
  };
}

interface JobFacts {
  blockers: Json[];
  pr?: Json;
  staff?: Json;
}

const BLOCKER_LABEL: Record<string, string> = { client_decision: 'Decision needed', no_convergence: 'Review not converging', unavailable_owner: 'Staff is offline' };
const shorten = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function jobNode(j: Json, f: JobFacts): MapNode {
  const blocked = j.status === 'blocked' || f.blockers.length > 0;
  const lines: [string, string][] = [['State', String(j.status).replaceAll('_', ' ')], ['Next', j.next_action]];
  if (blocked && !f.blockers.length && j.blocked_reason) lines.push(['Blocked', String(j.blocked_reason).replaceAll('_', ' ')]);
  if (f.staff) lines.push(['Staff', f.staff.nickname]);
  const waiting = f.blockers.map((b) => ({ kind: BLOCKER_LABEL[b.kind] ?? b.kind, text: shorten(String(b.requested_decision ?? ''), 160), href: `#/queue/${b.id}` }));
  // Short chips: what each one opens is clear from its word, the names are in the lines above.
  const links: { label: string; href: string; external?: boolean }[] = [{ label: 'Job', href: `#/jobs/${j.id}` }];
  if (f.staff) links.push({ label: 'Staff', href: `#/agents/${f.staff.id}` });
  if (f.pr) links.push({ label: String(f.pr.label).split('/').pop() ?? 'PR', href: f.pr.url, external: true });
  // The job's own ticket URL, so the link follows whichever Linear workspace the ticket is in.
  if (/^https:\/\/linear\.app\/[^/]+\/issue\//.test(j.linear_url ?? '')) links.push({ label: 'Linear', href: j.linear_url, external: true });
  return {
    key: `job-${j.id}`,
    kind: 'job',
    x: 0,
    y: 0,
    label: j.linear_identifier ?? 'job',
    sub: j.title,
    href: `#/jobs/${j.id}`,
    status: j.status,
    blocked,
    card: { title: `${j.linear_identifier}: ${j.title}`, lines, waiting, links },
  };
}

const CLOSED = new Set(['done', 'cancelled']);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Home: what needs the Client first, then the state of the work, the agents, recent events and plan limits. */
/** A quiet "?" in the bottom-right corner that opens a small popup with the two places to get help. Closes on a click outside, Escape or a link. */
function HelpButton() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    addEventListener('mousedown', away);
    addEventListener('keydown', escape);
    return () => {
      removeEventListener('mousedown', away);
      removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div className="help" ref={box}>
      <button type="button" className="help-trigger" aria-label="Help" aria-expanded={open} aria-controls="help-popup" data-testid="help-trigger" onClick={() => setOpen(!open)}>
        ?
      </button>
      {open && (
        <div id="help-popup" className="help-popup" role="dialog" aria-label="Help" data-testid="help-popup">
          <p>Need help?</p>
          <a href="#/guide" onClick={() => setOpen(false)}>Read the guide for more details</a>
          <a href="#/operator" onClick={() => setOpen(false)}>Ask the Operator assistant for help</a>
        </div>
      )}
    </div>
  );
}

function HomePage({ agents, jobs, queue, refining, inbox, finished, names, version }: { agents: Json[]; jobs: Json[]; queue: Json[]; refining: Json[]; inbox: Json[]; finished: number; names: Names; version: number }) {
  const feed = useData<Json[]>('/api/feed', version);
  const usage = useData<Json>('/api/usage', version);
  const open = jobs.filter((j) => !CLOSED.has(j.status));
  const parents = open.filter((j) => !j.parent_job_id);
  const blocked = open.filter((j) => j.status === 'blocked').length;
  const online = agents.filter((a) => presenceClass(a.presence) === 'online');
  const roles = ['staff', 'senior', 'reviewer', 'researcher'].map((r) => [r, online.filter((a) => a.role === r).length] as const).filter(([, n]) => n > 0);
  const rank = (j: Json) => (j.status === 'blocked' || j.next_action === 'Client decision needed' ? 0 : ['in_progress', 'in_review', 'delivering'].includes(j.status) ? 1 : 2);
  const shownJobs = [...open].sort((a, b) => rank(a) - rank(b) || String(b.last_activity).localeCompare(String(a.last_activity))).slice(0, 5);
  const needs = queue.length + refining.length;
  const critical = inbox.filter((m) => m.priority === 'critical').length;
  const shownAsks = queue.slice(0, 2);
  const shownRefine = refining.slice(0, 2 - shownAsks.length);
  const tiles = [
    {
      label: 'Needs you',
      value: needs + inbox.length + finished,
      note: [critical ? plural(critical, 'critical message') : '', needs ? plural(needs, 'decision') : '', finished ? plural(finished, 'finished job') : '', inbox.length - critical ? plural(inbox.length - critical, 'message') : '']
        .filter(Boolean)
        .join(', ') || 'nothing waiting',
      href: '#/queue',
      tone: critical ? 'bad' : needs + inbox.length + finished ? 'warn' : '',
    },
    { label: 'Jobs', value: parents.length, note: `${plural(open.length - parents.length, 'sub-job')}, ${blocked} blocked`, href: '#/jobs', tone: '' },
    { label: 'Agents', value: online.length, note: roles.map(([r, n]) => `${n} ${r}`).join(', ') || 'none online', href: '#/agents', tone: online.length ? 'good' : '' },
  ];
  const windows = (rows: Json[] | undefined) => (rows?.length ? rows.map((r) => `${WINDOW_LABEL[r.window] ?? r.window} ${Math.round(r.used)}%`).join(', ') : undefined);
  const latestDay = (usage.data?.by_day ?? []).map((r: Json) => r.day as string).sort().at(-1);
  const latestOutput = (usage.data?.by_day ?? []).filter((r: Json) => r.day === latestDay).reduce((s: number, r: Json) => s + r.output, 0);
  // Claude Code gives Triglav no usage unless the status line script reports it. Until then the card shows only a refusal that still
  // applies, marked with *: a refusal that has since reset says nothing about now, so it is not shown as 0%.
  const claudeRows: Json[] = usage.data?.limits?.claude ?? [];
  const claudeExact = claudeRows.some((r) => r.source === 'statusline' || r.source === 'stream');
  const claudeShown = claudeExact ? claudeRows : claudeRows.filter((r) => !r.reset);
  const limits: [string, string][] = [
    ['Claude plan', usage.data ? `${windows(claudeShown) ?? 'No limit reached'}${claudeExact ? '' : '*'}` : '...'],
    ['Codex plan', usage.data ? (windows(usage.data.limits?.codex) ?? 'No reading yet') : '...'],
    ['Tokens', usage.data ? (latestDay ? `${fmtTokens(latestOutput)} output on ${latestDay}` : 'No usage recorded yet') : '...'],
  ];
  return (
    <div className="dash" data-testid="home">
      <HelpButton />
      <div>
        <h1>Overview</h1>
        <p className="muted">
          {needs ? `${plural(needs, 'decision')} ${needs === 1 ? 'needs' : 'need'} you.` : 'Nothing needs you right now.'} {plural(parents.length, 'active job')}, {plural(online.length, 'agent')} online.
        </p>
      </div>
      <div className="dash-row">
        <section className={`dash-card col-5${needs ? ' attention-card' : ''}`} data-testid="home-needs">
          <div className="section-head">
            <h2 className={needs ? 'attention' : ''}>Needs your decision</h2>
          </div>
          {needs === 0 && <p className="muted">Nothing needs you right now. A decision shows up here the moment an agent is blocked on you.</p>}
          {shownAsks.map((b) => (
            <div key={b.id} className="dash-ask">
              <p className="muted">
                <Pill value={b.kind} kind="blocker" /> <a href={`#/jobs/${b.job_id}`}>{b.linear_identifier}</a> {b.job_title} · <Ago ts={b.created_at} />
              </p>
              <LongText text={b.requested_decision} names={names} limit={220} />
            </div>
          ))}
          {shownRefine.map((j) => (
            <div key={j.id} className="dash-ask">
              <p className="muted">
                <a href={`#/jobs/${j.id}`}>{j.linear_identifier}</a> {j.title} · <Ago ts={j.last_activity ?? j.updated_at} />
              </p>
              <p>Staff is refining this job with you. Answer its questions and approve the goal and criteria.</p>
            </div>
          ))}
          {needs > shownAsks.length + shownRefine.length && <p className="muted">and {needs - shownAsks.length - shownRefine.length} more</p>}
          {finished > 0 && (
            <p>
              <a href="#/queue">{plural(finished, 'finished job')}</a> to look at.
            </p>
          )}
          {inbox.length > 0 && (
            <p>
              <a href="#/queue">{plural(inbox.length, 'unread message')}</a> for you from agents.
            </p>
          )}
          {needs > 0 && (
            <a className="button primary" href="#/queue">
              Review and answer
            </a>
          )}
        </section>
        <div className="col-7 dash-stack">
          <div className="tiles">
            {tiles.map((t) => (
              <a key={t.label} className="tile" href={t.href} data-testid={`tile-${t.label.toLowerCase().replace(' ', '-')}`}>
                <span className="tile-label">{t.label}</span>
                <strong className={t.tone}>{t.value}</strong>
                <span className="muted">{t.note}</span>
              </a>
            ))}
          </div>
          <section className="dash-card">
            <div className="section-head">
              <h2>How Triglav works</h2>
            </div>
            <ol className="how">
              <li>Start a job from a ticket link or a prompt.</li>
              <li>Staff plans it and starts Seniors. Reviewers check the result.</li>
              <li>You decide only when an agent is blocked. Decisions show up here.</li>
            </ol>
            <p className="actions">
              <a href="#/new">Start a job</a>
              <a href="#/guide">Read the guide</a>
            </p>
          </section>
        </div>
      </div>
      <div className="dash-row">
        <section className="dash-card col-7">
          <div className="section-head">
            <h2>Jobs</h2>
            <a href="#/jobs">All jobs ({jobs.length})</a>
          </div>
          {shownJobs.length === 0 ? (
            <p className="muted">
              No open jobs. <a href="#/new">Start one</a>.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>State</th>
                  <th>Next action</th>
                </tr>
              </thead>
              <tbody>
                {shownJobs.map((j) => (
                  <tr key={j.id} data-testid="home-job" data-identifier={j.linear_identifier}>
                    <td>
                      <a href={`#/jobs/${j.id}`}>{j.linear_identifier}</a> {j.title}
                    </td>
                    <td>
                      <Pill value={j.status} />
                    </td>
                    <td className={j.next_action === 'Client decision needed' ? 'attention' : ''}>{j.next_action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="dash-card col-5">
          <div className="section-head">
            <h2>Agents</h2>
            <a href="#/agents">All agents</a>
          </div>
          {online.length === 0 ? (
            <p className="muted">
              No agents online. Start a Staff agent from the <a href="#/models">Models page</a>.
            </p>
          ) : (
            <ul className="dash-list">
              {online.slice(0, 6).map((a) => (
                <li key={a.id}>
                  <span className="dot" />
                  <span className="grow">
                    <a href={`#/agents/${a.id}`}>{a.nickname}</a> <span className="muted">{a.role}</span>
                  </span>
                  <span className="muted">{a.held?.[0] ? `${a.held[0].kind} #${a.held[0].attempt}` : a.focus}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <div className="dash-row">
        <section className="dash-card col-7">
          <div className="section-head">
            <h2>Latest activity</h2>
            <a href="#/activity">All activity</a>
          </div>
          <FeedList items={(feed.data ?? []).slice(0, 6)} />
        </section>
        <section className="dash-card col-5" data-testid="home-usage">
          <div className="section-head">
            <h2>Usage and limits</h2>
            <a href="#/usage">Details</a>
          </div>
          <dl className="dash-facts">
            {limits.map(([k, v]) => (
              <div key={k}>
                <dt className="muted">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {usage.data && !claudeExact && (
            <p className="muted dash-footnote" data-testid="claude-estimate-note">
              * Claude Code does not report plan usage to Triglav, so a limit shows here only after a request is refused. For exact percentages, use <code>scripts/claude-statusline.sh</code> as your Claude Code status line (see the README).
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/** The live map: who works on what right now. It was Home before the dashboard. */
function LivePage({ agents, jobs, blockers, version }: { agents: Json[]; jobs: Json[]; blockers: Json[]; version: number }) {
  const extras = useData<Json>('/api/map', version + Math.floor(Date.now() / 30_000));
  const { nodes, edges, height } = useMemo(() => layout(agents, jobs, blockers, extras.data), [agents, jobs, blockers, extras.data]);
  const [box, zoom] = useFit(height);
  const feed = useData<Json[]>('/api/feed', version);
  const [hover, setHover] = useState<string | null>(null);
  // The card has links, so the pointer must be able to cross from the node to it: leaving either only closes it after a short delay.
  const closing = useRef<number>(0);
  const showCard = (key: string) => {
    clearTimeout(closing.current);
    setHover(key);
  };
  const hideCard = () => {
    closing.current = window.setTimeout(() => setHover(null), 200);
  };
  const at = new Map(nodes.map((n) => [n.key, n]));
  const hovered = hover ? at.get(hover) : undefined;
  return (
    <div className="home" data-testid="live-map">
      <TabStrip label="Activity" tabs={ACTIVITY_TABS} current="live" floating />
      <div className="map-wrap" ref={box}>
      <div className="map" style={{ width: MAP_W, height, zoom }}>
        <svg viewBox={`0 0 ${MAP_W} ${height}`} className="edges" aria-hidden="true">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,1 L9,5 L0,9 z" className="arrowhead" />
            </marker>
            <marker id="arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,1 L9,5 L0,9 z" className="arrowhead active" />
            </marker>
          </defs>
          {edges.map((e) => {
            const p = at.get(e.from);
            const q = at.get(e.to);
            if (!p || !q) return null;
            // From the edge of one node to the edge of the other, so the arrowhead sits at the node and not under it.
            const forward = q.x >= p.x;
            const sx = p.x + (forward ? 1 : -1) * (SIZE[p.kind][0] / 2);
            const ex = q.x + (forward ? -1 : 1) * (SIZE[q.kind][0] / 2);
            const mx = (sx + ex) / 2;
            const dim = e.presence === 'stale' || e.presence === 'offline';
            return (
              <path
                key={`${e.from}-${e.to}`}
                d={`M${sx},${p.y} C${mx},${p.y} ${mx},${q.y} ${ex},${q.y}`}
                className={`edge${dim ? ' dim' : ''}${e.active ? ' active' : ''}${e.pulse && !e.active ? ' pulse' : ''}`}
                markerEnd={e.arrow ? (e.active ? 'url(#arrow-active)' : 'url(#arrow)') : undefined}
              />
            );
          })}
        </svg>
        {nodes.map((n) => (
          <a
            key={n.key}
            href={n.href}
            {...(n.external ? { target: '_blank', rel: 'noreferrer' } : {})}
            className={`node node-${n.kind} st-${n.status ?? ''}${n.working ? ' working' : ''}${n.blocked ? ' blocked' : ''}`}
            style={{ left: n.x, top: n.y, ...(n.kind !== 'center' && { width: SIZE[n.kind][0], height: SIZE[n.kind][1] }) }}
            onMouseEnter={() => showCard(n.key)}
            onMouseLeave={hideCard}
            data-testid={`map-${n.kind}`}
          >
            {n.kind === 'center' ? (
              <>
                <img src="/android-chrome-512x512.png" alt="" />
                <span className="caption">Triglav</span>
              </>
            ) : n.kind === 'job' ? (
              <span className="hex">
                {n.blocked && (
                  <svg className="blocked-icon" viewBox="0 0 16 16" width="14" height="14" aria-label="Blocked">
                    <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M4.5 11.5l7-7" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                )}
                {n.status === 'in_progress' && (
                  <svg className="working-icon" viewBox="0 0 16 16" width="14" height="14" role="img" aria-label="In progress">
                    <title>In progress: a Senior is implementing</title>
                    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                    <path d="M8 2a6 6 0 1 1-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                )}
                {(n.status === 'in_review' || n.status === 'delivering') && (
                  <svg className="review-icon" viewBox="0 0 16 16" width="14" height="14" role="img" aria-label={n.status === 'in_review' ? 'In review' : 'Delivering'}>
                    <title>{n.status === 'in_review' ? 'In review' : 'Delivering: review and CI loop'}</title>
                    <path d="M1.5 8C3 5 5.3 3.5 8 3.5S13 5 14.5 8C13 11 10.7 12.5 8 12.5S3 11 1.5 8Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                    <circle cx="8" cy="8" r="2" fill="currentColor" />
                  </svg>
                )}
                {n.label}
                {n.sub && <small className="job-title">{n.sub}</small>}
              </span>
            ) : n.kind === 'pr' ? (
              <>
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path d="M5 3.25a1.75 1.75 0 1 1-2.5 1.58v6.34a1.75 1.75 0 1 1-1.5 0V4.83A1.75 1.75 0 0 1 5 3.25Zm6.5 6.42V6.5A2.5 2.5 0 0 0 9 4H7.56l1.22-1.22-1.06-1.06L4.69 4.75l3.03 3.03 1.06-1.06L7.56 5.5H9a1 1 0 0 1 1 1v3.17a1.75 1.75 0 1 0 1.5 0Z" />
                </svg>
                <span className="name">{n.label}</span>
              </>
            ) : n.kind === 'copilot' ? (
              <>
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                  <path d="M12 3c-4.5 0-8 2.3-8 6.2v3.6C4 17.3 7.6 21 12 21s8-3.7 8-8.2V9.2C20 5.3 16.5 3 12 3Zm-3.2 8.3a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Zm6.4 0a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6ZM7 8.3c1.4-1 3.1-1.5 5-1.5s3.6.5 5 1.5" />
                </svg>
                <span className="name">{n.label}</span>
                <span className="role">{n.sub}</span>
              </>
            ) : (
              <>
                <span className="name">{n.label}</span>
                <span className="role">{n.sub}</span>
              </>
            )}
          </a>
        ))}
        {hovered && (
          <div
            className="map-card"
            data-testid="map-card"
            style={{ left: hovered.x - SIZE[hovered.kind][0] / 2, top: hovered.y + SIZE[hovered.kind][1] / 2 - 4 }}
            onMouseEnter={() => showCard(hovered.key)}
            onMouseLeave={hideCard}
          >
            <strong>{hovered.card.title}</strong>
            {hovered.card.lines.map(([k, v]) => (
              <div key={k}>
                <span className="muted">{k}</span> {v}
              </div>
            ))}
            {hovered.card.waiting?.map((w) => (
              <div key={w.href} className="map-card-waiting">
                <span className="map-card-kind">{w.kind}</span>
                <p>{w.text}</p>
                <a className="button" href={w.href}>Open decision</a>
              </div>
            ))}
            {hovered.card.links && (
              <div className="map-card-links">
                {hovered.card.links.map((l) => (
                  <a key={l.href} className="chip" href={l.href} {...(l.external ? { target: '_blank', rel: 'noreferrer' } : {})}>
                    {l.label}
                    {l.external ? ' ↗' : ''}
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
        {nodes.length === 1 && <p className="map-empty">No agents online. Start a Staff agent from the Models page.</p>}
      </div>
      </div>
      <div className="home-feed">
        <div className="section-head">
          <h3>Latest activity</h3>
          <a href="#/activity">All</a>
        </div>
        <FeedList items={(feed.data ?? []).slice(0, 8)} />
      </div>
    </div>
  );
}

/* ---------- Guide ---------- */

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// Raw HTML is shown as text, so a stray <placeholder> stays visible and nothing can inject markup. Only http(s) and in-app links
// stay links, and images are not loaded: the Operator's replies are model output and can repeat text from a ticket or a log.
const markdown = new Marked({
  renderer: {
    html: ({ text }) => escapeHtml(text),
    link: ({ href, text }) => (/^(https?:\/\/|#\/)/.test(href) ? `<a href="${escapeHtml(href)}"${href.startsWith('#') ? '' : ' target="_blank" rel="noreferrer"'}>${escapeHtml(text)}</a>` : escapeHtml(text)),
    image: ({ text }) => escapeHtml(text),
  },
});
const guideHtml = markdown.parse(userGuide, { async: false });

/** Successful logins through the public dashboard listener. The address comes from the proxy's header: plain text only. */
function SecurityPage({ version }: { version: number }) {
  const { data, error } = useData<{ logins: { at: string; address: string }[] }>('/api/security/logins', version);
  return (
    <Section title="Logins through the reverse proxy">
      <p className="muted">
        Each successful login through the HTTPS reverse proxy (ORCH_DASHBOARD_URL), newest first, at most 50 from the last 90 days. Logins on this machine (localhost or an SSH tunnel) are not listed. If you see one that was not you,
        set a new password with node scripts/set-password.ts and restart the server: that ends every session.
      </p>
      {error && <p className="error">{error}</p>}
      {data && data.logins.length === 0 && <p className="muted" data-testid="security-empty">No logins through the reverse proxy yet.</p>}
      {data && data.logins.length > 0 && (
        <table data-testid="security-logins">
          <thead>
            <tr>
              <th>Time</th>
              <th>Client address</th>
            </tr>
          </thead>
          <tbody>
            {data.logins.map((l, i) => (
              <tr key={`${l.at}-${i}`}>
                <td>{fmt(l.at)}</td>
                <td>{l.address}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

/** How to work with Triglav, for the Client. The agents' guide in src/guide/ is served only at /guide.md and is not shown here. */
function GuidePage() {
  return <article className="guide" data-testid="guide" dangerouslySetInnerHTML={{ __html: guideHtml }} />;
}

/* ---------- Operator ---------- */

type ChatMsg = { id: number; role: string; text: string };
type ChatActionRow = { id: string; kind: string; summary: string; reason: string | null; state: string; result: string | null };

const ACTION_OUTCOME: Record<string, string> = { denied: 'Denied.', expired: 'Too old to confirm.', running: 'Confirmed. Waiting for the host runner...' };

/** A change the Operator asks for. The text is written by Triglav from its own data; nothing happens until the Client confirms. */
function ActionCard({ a, chatId }: { a: ChatActionRow | undefined; chatId: string }) {
  const act = useAction();
  if (!a) return null;
  const decide = (decision: 'confirm' | 'deny') => act.run(() => post(`/api/chats/${chatId}/actions/${a.id}`, { decision }));
  return (
    <div className={`chat-action action-${a.state}`} data-testid="chat-action" data-state={a.state} data-kind={a.kind}>
      <div className="chat-action-head">{a.state === 'pending' ? 'The Operator asks to' : 'The Operator asked to'}</div>
      <p className="chat-action-summary">{a.summary}</p>
      {a.reason && <p className="muted">Its reason: {a.reason}</p>}
      {a.state === 'pending' ? (
        <div className="actions">
          <button className="primary" disabled={act.busy} data-testid="action-confirm" onClick={() => void decide('confirm')}>
            Confirm
          </button>
          <button disabled={act.busy} data-testid="action-deny" onClick={() => void decide('deny')}>
            Deny
          </button>
          {act.error && <span className="error">{act.error}</span>}
        </div>
      ) : (
        <p className={a.state === 'failed' ? 'error' : 'muted'}>{a.state === 'done' ? `Done. ${a.result ?? ''}` : a.state === 'failed' ? `Failed. ${a.result ?? ''}` : ACTION_OUTCOME[a.state]}</p>
      )}
    </div>
  );
}

const OPERATOR_IDEAS = ['What needs my attention?', 'Why is an agent offline?', 'How do I resume a stopped Staff?'];

/** A Claude Code chat on the Client's machine, for how-to questions and for finding out why something is stuck. */
function OperatorPage({ chatId, version }: { chatId: string | undefined; version: number }) {
  const chats = useData<Json[]>('/api/chats', version);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [partial, setPartial] = useState('');
  const [state, setState] = useState<string | null>(null);
  const [actions, setActions] = useState<Record<string, ChatActionRow>>({});
  const [text, setText] = useState('');
  const send = useAction();
  const end = useRef<HTMLDivElement>(null);
  // A new chat is not an event, so the list is read again when the chat changes.
  useEffect(() => {
    chats.reload();
  }, [chatId]);

  useEffect(() => {
    setMessages([]);
    setPartial('');
    setState(null);
    setActions({});
    if (!chatId) return;
    let alive = true;
    const load = () =>
      get<Json>(`/api/chats/${chatId}`).then((c) => {
        if (!alive) return;
        // Messages that streamed in meanwhile are already there: keep one of each.
        setMessages((have) => [...new Map([...have, ...c.messages].map((m: ChatMsg) => [m.id, m])).values()].sort((a, b) => a.id - b.id));
        setActions((have) => ({ ...have, ...Object.fromEntries(c.actions.map((x: ChatActionRow) => [x.id, x])) }));
        setState((s) => s ?? c.state);
      });
    const source = new EventSource(`/api/chats/${chatId}/stream`);
    source.onmessage = (ev) => {
      const e = JSON.parse(ev.data);
      if (e.type === 'hello') {
        setPartial(e.partial);
        void load();
      } else if (e.type === 'delta') setPartial((p) => p + e.text);
      else if (e.type === 'message') {
        setMessages((have) => (have.some((m) => m.id === e.message.id) ? have : [...have, e.message]));
        if (e.message.role === 'operator') setPartial('');
      } else if (e.type === 'action') setActions((have) => ({ ...have, [e.action.id]: e.action }));
      else if (e.type === 'state') {
        setState(e.state);
        if (e.state !== 'working') setPartial('');
      }
    };
    return () => {
      alive = false;
      source.close();
    };
  }, [chatId]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, partial]);

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    const ok = await send.run(async () => {
      if (chatId) await post(`/api/chats/${chatId}/messages`, { text: t });
      else location.hash = `#/operator/${(await post<{ id: string }>('/api/chats', { text: t })).id}`;
    });
    if (ok) setText('');
  };
  const working = state === 'working';
  return (
    <div className="operator" data-testid="operator">
      <div className="operator-bar">
        <select aria-label="Chat" value={chatId ?? ''} onChange={(e) => (location.hash = e.target.value ? `#/operator/${e.target.value}` : '#/operator')}>
          <option value="">New chat</option>
          {(chats.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <span className="muted operator-note">Reads your machine and Triglav. Anything it wants to change waits for your confirmation.</span>
      </div>
      <div className="chat-log" data-testid="chat-log">
        {!chatId && (
          <div className="chat-empty">
            <h2>Operator</h2>
            <p className="muted">Ask how Triglav works, why an agent is stuck, or what needs you. It looks at the live state, the runner logs and the repository before it answers.</p>
            <div className="actions">
              {OPERATOR_IDEAS.map((i) => (
                <button key={i} onClick={() => setText(i)}>
                  {i}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === 'operator' ? (
            <div key={m.id} className="chat-msg operator-says" data-testid="chat-operator" dangerouslySetInnerHTML={{ __html: markdown.parse(m.text, { async: false }) }} />
          ) : m.role === 'action' ? (
            <ActionCard key={m.id} a={actions[m.text]} chatId={chatId!} />
          ) : m.role === 'client' ? (
            <div key={m.id} className="chat-msg client-says" data-testid="chat-client">
              {m.text}
            </div>
          ) : (
            <div key={m.id} className={`chat-note ${m.role}`} data-testid={`chat-${m.role}`}>
              {m.role === 'tool' ? `Looked at: ${m.text}` : m.text}
            </div>
          ),
        )}
        {partial && <div className="chat-msg operator-says streaming" data-testid="chat-partial" dangerouslySetInnerHTML={{ __html: markdown.parse(partial, { async: false }) }} />}
        {working && !partial && <div className="chat-note muted">Working...</div>}
        <div ref={end} />
      </div>
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          aria-label="Message"
          placeholder="Ask the Operator"
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="actions">
          <button className="primary" disabled={send.busy || !text.trim()} data-testid="chat-send">
            Send
          </button>
          {working && chatId && (
            <button type="button" className="danger" data-testid="chat-stop" onClick={() => void post(`/api/chats/${chatId}/stop`, {})}>
              Stop
            </button>
          )}
          {send.error && <span className="error">{send.error}</span>}
        </div>
      </form>
    </div>
  );
}

/* ---------- Activity feed ---------- */

const FEED_ICON: Record<string, string> = {
  'artifact.recorded': '⎇',
  'review.submitted': '✓',
  'review.verdict': '⚖',
  'delivery.reported': '⇪',
  'delivery.confirmed': '★',
  'job.status': '●',
  'message.posted': '✎',
  'question.opened': '?',
  'decision.recorded': '◆',
  'blocker.raised': '!',
};

function FeedList({ items }: { items: Json[] }) {
  if (items.length === 0) return <p className="muted">Nothing yet</p>;
  return (
    <ul className="feed" data-testid="feed">
      {items.map((f) => (
        <li key={f.id} className={`feed-${f.type.replace('.', '-')}`}>
          <span className="feed-icon">{FEED_ICON[f.type] ?? '•'}</span>
          {f.link ? (
            <a href={f.link} {...(f.link.startsWith('http') ? { target: '_blank', rel: 'noreferrer' } : {})}>
              {f.text}
            </a>
          ) : (
            <span>{f.text}</span>
          )}
          <span className="muted feed-at">
            <Ago ts={f.at} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function ActivityPage({ version }: { version: number }) {
  const feed = useData<Json[]>('/api/feed', version);
  const [kind, setKind] = useState('all');
  const items = (feed.data ?? []).filter((f) => kind === 'all' || (kind === 'code' ? f.type === 'artifact.recorded' : kind === 'board' ? ['message.posted', 'question.opened', 'decision.recorded'].includes(f.type) : !['artifact.recorded', 'message.posted', 'question.opened', 'decision.recorded'].includes(f.type)));
  return (
    <Section
      title="Activity"
      actions={
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter">
          <option value="all">Everything</option>
          <option value="code">Commits, branches, PRs</option>
          <option value="board">Board</option>
          <option value="work">Work and reviews</option>
        </select>
      }
    >
      {feed.error && <p className="error">{feed.error}</p>}
      <FeedList items={items} />
    </Section>
  );
}

/* ---------- Usage ---------- */

const fmtTokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const MODEL_COLORS = ['#7ea2ff', '#6fcf8f', '#f0a24b', '#d78bff', '#4fd1c5', '#ff7a70'];

const WINDOW_LABEL: Record<string, string> = { five_hour: 'Session (5 hr)', seven_day: 'Weekly (7 day)', seven_day_opus: 'Weekly Opus (7 day)' };

/** "3h", "6d", "40m": time until a reset, rounded down. */
function untilShort(ts: string | null): string {
  if (!ts) return '';
  const min = Math.max(0, Math.floor((new Date(ts).getTime() - Date.now()) / 60_000));
  return min >= 1440 ? `${Math.floor(min / 1440)}d` : min >= 60 ? `${Math.floor(min / 60)}h` : `${min}m`;
}

/** Share of each plan window in use, with time to reset and the reset date, per provider. */
function PlanLimits({ limits }: { limits?: { claude: Json[]; codex: Json[] } }) {
  const providers = [
    {
      name: 'Claude',
      rows: limits?.claude ?? [],
      empty: 'No limit reached. Claude Code does not record how much of the plan is used, so Triglav cannot show a percentage. A window appears here at 100%, with its reset time, as soon as a request is refused.',
      note: 'Exact percentages need scripts/claude-statusline.sh as your status line (see README).',
    },
    { name: 'Codex', rows: limits?.codex ?? [], empty: 'No reading yet. Codex reports it in every session transcript.' },
  ];
  return (
    <Section title="Plan limits">
      <div className="plan-limits">
        {providers.map((p) => (
          <div key={p.name} className="plan-provider" data-testid={`plan-${p.name.toLowerCase()}`}>
            <h3>{p.name}</h3>
            {p.rows.length === 0 && <p className="muted">{p.empty}</p>}
            {'note' in p && !p.rows.some((r) => r.source === 'statusline') && <p className="muted">{p.note}</p>}
            {p.rows.map((r) => (
              <div key={r.window} className="plan-window">
                <div className="plan-head">
                  <span>{WINDOW_LABEL[r.window] ?? r.window}</span>
                  <strong>{Math.round(r.used)}%</strong>
                </div>
                <div className={`meter${r.used >= 90 ? ' meter-bad' : r.used >= 70 ? ' meter-warn' : ''}`}>
                  <div style={{ width: `${Math.min(100, r.used)}%` }} />
                </div>
                <span className="muted">
                  {r.reset ? 'Window has reset since the last reading' : r.resets_at ? `Resets in ${untilShort(r.resets_at)} · ${fmt(r.resets_at)}` : 'Reset time unknown'}
                  {` · read ${fmt(r.observed_at)}`}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Section>
  );
}

function UsagePage({ version }: { version: number }) {
  const { data, error } = useData<Json>('/api/usage', version);
  const [metric, setMetric] = useState<'output' | 'input' | 'cache_read' | 'cache_write'>('output');
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading</p>;
  const models = [...new Set<string>(data.by_day.map((r: Json) => r.model))];
  const color = (m: string) => MODEL_COLORS[models.indexOf(m) % MODEL_COLORS.length];
  const days = [...new Set<string>(data.by_day.map((r: Json) => r.day))];
  const value = (r: Json) => (metric === 'input' ? r.input : r[metric]) as number;
  const perDay = days.map((d) => ({ day: d, rows: data.by_day.filter((r: Json) => r.day === d) }));
  const max = Math.max(1, ...perDay.map((d) => d.rows.reduce((s: number, r: Json) => s + value(r), 0)));
  const totals = models.map((m) => ({ model: m, rows: data.by_day.filter((r: Json) => r.model === m) }));
  return (
    <>
      <PlanLimits limits={data.limits} />
      <div className="stat-row">
        {totals.map((t) => (
          <div key={t.model} className="stat" style={{ borderTopColor: color(t.model) }}>
            <span className="muted">{t.model}</span>
            <strong>{fmtTokens(t.rows.reduce((s: number, r: Json) => s + r.output, 0))}</strong>
            <span className="muted">
              output · {fmtTokens(t.rows.reduce((s: number, r: Json) => s + r.input + r.cache_write, 0))} input · {fmtTokens(t.rows.reduce((s: number, r: Json) => s + r.cache_read, 0))} cache read
            </span>
          </div>
        ))}
      </div>
      <Section
        title="Tokens per day"
        actions={
          <select value={metric} onChange={(e) => setMetric(e.target.value as typeof metric)} aria-label="Metric">
            <option value="output">Output</option>
            <option value="input">Input (uncached)</option>
            <option value="cache_write">Cache write</option>
            <option value="cache_read">Cache read</option>
          </select>
        }
      >
        <p className="muted">From the agents' own CLI transcripts, for sessions registered with Triglav. Updated every minute.</p>
        {perDay.length === 0 && <p className="muted">No usage recorded yet</p>}
        <div className="bars" data-testid="usage-bars">
          {perDay.map((d) => (
            <div key={d.day} className="bar-row">
              <span className="muted bar-day">{d.day}</span>
              <div className="bar-track">
                {d.rows.map((r: Json) => (
                  <span key={r.model} className="bar-seg" title={`${r.model}: ${value(r).toLocaleString()}`} style={{ width: `${(value(r) / max) * 100}%`, background: color(r.model) }} />
                ))}
              </div>
              <span className="bar-total">{fmtTokens(d.rows.reduce((s: number, r: Json) => s + value(r), 0))}</span>
            </div>
          ))}
        </div>
        <div className="legend">
          {models.map((m) => (
            <span key={m}>
              <i style={{ background: color(m) }} /> {m}
            </span>
          ))}
        </div>
      </Section>
      <Section title="By agent">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Model</th>
              <th>Output</th>
              <th>Input</th>
              <th>Cache write</th>
              <th>Cache read</th>
            </tr>
          </thead>
          <tbody>
            {data.by_agent.map((r: Json) => (
              <tr key={`${r.agent_id}-${r.model}`}>
                <td>
                  {r.agent_id ? <a href={`#/agents/${r.agent_id}`}>{r.nickname ?? r.agent_id}</a> : 'unknown'} <span className="muted">{r.role}</span>
                  {r.sessions > 1 && <span className="muted"> · {r.sessions} sessions</span>}
                </td>
                <td>{r.model}</td>
                <td>{fmtTokens(r.output)}</td>
                <td>{fmtTokens(r.input)}</td>
                <td>{fmtTokens(r.cache_write)}</td>
                <td>{fmtTokens(r.cache_read)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}

function Artifacts({ jobId, version }: { jobId: string; version: number }) {
  const { data } = useData<Json[]>(`/api/artifacts?job_id=${jobId}`, version);
  if (!data || data.length === 0) return null;
  return (
    <Section title="Code: branches, pushes, PRs">
      <ul className="feed">
        {data.map((a) => (
          <li key={a.id}>
            <span className="feed-icon">{a.kind === 'pr' ? '⇄' : a.kind === 'branch' ? '⎇' : '↑'}</span>
            <a href={a.url} target="_blank" rel="noreferrer">
              {a.kind === 'pr' ? 'PR' : a.kind === 'branch' ? 'Branch' : 'Push'} {a.label}
            </a>
            <span className="muted feed-at">
              <Ago ts={a.at} />
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
