import { tx, type Ctx } from './context.ts';
import { exec, parseJson, query, queryOne, type Conn } from './db.ts';
import { applyOps, DesignError, type Doc, type Block } from './design.ts';
import { evaluateCards, gateKeyOf, gateLabel, type CardStart, type Facts, type GateRow } from './card-state.ts';
import { buildCardPrompt, type MergedDependency } from './card-prompt.ts';
import { parseGateOutput, parsePrUrl, provesMerged, type GateOutput } from './gate-check.ts';
import { initiativeByKey, versionOf } from './initiatives.ts';
import { MAX_PROMPT, queueRequest } from './job-requests.ts';
import { assertNoSecrets, conflict, invalid, newId, notFound } from './lib.ts';

/**
 * Initiative jobs and gates (docs/plans/initiative-room.md, phase 2): the one gate evaluator's facts, Start from a job
 * card, manual marks, and the runner's merged check. The design itself is changed only here by a new version whose
 * trigger is a check (`event`) or the Client's mark (`client_edit`); a Confirm card is never involved.
 */

/** The shortest time between two checks of one open merged gate. */
export const GATE_CHECK_MS = 10 * 60_000;

type Initiative = Awaited<ReturnType<typeof initiativeByKey>>;
type Source = { ok: true; card: string; pr_url: string; number: number; slug: string } | { ok: false; reason: string };

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const evidenceOf = (v: unknown): Record<string, unknown> | null => (v == null ? null : parseJson<Record<string, unknown>>(v));

/** A card's latest start: the request it stands for, and the design version its prompt was built from. */
type StartRow = { card_key: string; request_id: string; started_from_version: number; started_at: unknown };

/**
 * The latest start of each card (of one card when cardKey is given). A retry of a failed request names it in
 * job_requests.retry_of, and the retry is the same start, so the chain is followed to its newest request.
 */
async function latestStarts(conn: Conn, initiativeId: string, cardKey?: string): Promise<Map<string, StartRow>> {
  const rows = await query(
    conn,
    `SELECT card_key, request_id, started_from_version, started_at FROM initiative_card_starts WHERE initiative_id = ?${cardKey ? ' AND card_key = ?' : ''} ORDER BY started_at DESC`,
    cardKey ? [initiativeId, cardKey] : [initiativeId],
  );
  const latest = new Map<string, StartRow>();
  for (const r of rows) {
    const card = String(r.card_key);
    if (!latest.has(card)) latest.set(card, { card_key: card, request_id: String(r.request_id), started_from_version: Number(r.started_from_version), started_at: r.started_at });
  }
  const child = new Map<string, string>();
  let heads = [...latest.values()].map((s) => s.request_id);
  while (heads.length) {
    const kids = await query(conn, `SELECT id, retry_of FROM job_requests WHERE retry_of IN (${heads.map(() => '?').join(', ')}) ORDER BY created_at`, heads);
    if (!kids.length) break;
    for (const k of kids) child.set(String(k.retry_of), String(k.id));
    heads = kids.map((k) => String(k.id));
  }
  for (const s of latest.values()) {
    for (let hops = 0; child.has(s.request_id) && hops < 50; hops++) s.request_id = child.get(s.request_id)!;
  }
  return latest;
}

/** The gate rows and each card's latest start, read on one connection. */
export async function loadFacts(conn: Conn, initiativeId: string): Promise<Facts> {
  const gateRows = await query(conn, 'SELECT card_key, gate_key, met_at, met_by, reason, evidence FROM initiative_gates WHERE initiative_id = ?', [initiativeId]);
  const rows = new Map<string, GateRow>(
    gateRows.map((r) => [`${r.card_key}|${r.gate_key}`, { met_at: iso(r.met_at), met_by: r.met_by ?? null, reason: r.reason ?? null, evidence: evidenceOf(r.evidence) }]),
  );
  const latest = await latestStarts(conn, initiativeId);
  const requests = new Map<string, { status: string; job_id: string | null; dismissed_at: unknown; job_status: string | null }>();
  if (latest.size) {
    const ids = [...latest.values()].map((s) => s.request_id);
    const found = await query(conn, `SELECT r.id, r.status, r.job_id, r.dismissed_at, j.status AS job_status FROM job_requests r LEFT JOIN jobs j ON j.id = r.job_id WHERE r.id IN (${ids.map(() => '?').join(', ')})`, ids);
    for (const r of found) requests.set(String(r.id), { status: String(r.status), job_id: r.job_id ?? null, dismissed_at: r.dismissed_at, job_status: r.job_status ?? null });
  }
  const starts = new Map<string, CardStart>();
  for (const s of latest.values()) {
    const r = requests.get(s.request_id);
    if (!r) continue;
    starts.set(s.card_key, {
      request_status: r.status,
      job_id: r.job_id,
      job_status: r.job_status,
      dismissed: r.dismissed_at != null,
      started_from_version: s.started_from_version,
      started_at: iso(s.started_at) ?? '',
    });
  }
  return { rows, starts };
}

/** Implementation jobs started from this initiative's cards that still run (or wait for Staff to register them). */
async function runningCardJobs(conn: Conn, initiativeId: string): Promise<number> {
  // Each card counts through its live request: latestStarts follows a retry chain to its newest request, so a retried
  // start counts once and the request it replaced does not.
  const ids = [...(await latestStarts(conn, initiativeId)).values()].map((s) => s.request_id);
  if (!ids.length) return 0;
  const r = await queryOne(
    conn,
    `SELECT COUNT(*) AS n FROM job_requests r LEFT JOIN jobs j ON j.id = r.job_id
      WHERE r.id IN (${ids.map(() => '?').join(', ')}) AND ((j.id IS NULL AND r.status IN ('queued', 'started') AND r.dismissed_at IS NULL) OR (j.id IS NOT NULL AND j.kind = 'implement' AND j.status NOT IN ('done', 'cancelled')))`,
    ids,
  );
  return Number(r?.n ?? 0);
}

/** The room's Jobs tab: every card with its state, its gates and the waves they sit in, for the current version. */
export async function cardJobs(ctx: Ctx, key: string) {
  const i = await initiativeByKey(ctx.pool, key);
  const v = await versionOf(ctx.pool, i.id, i.current_version);
  const cards = evaluateCards(v.doc, i.milestones_open, await loadFacts(ctx.pool, i.id));
  const waves = v.doc.blocks.filter((b): b is Extract<Block, { kind: 'wave' }> => b.kind === 'wave').map((w) => ({ id: w.id, title: w.title, when: w.when }));
  return { key: i.key, version: v.version, current_version: i.current_version, cap: i.cap, running: await runningCardJobs(ctx.pool, i.id), waves, cards };
}

/** The repository a card names, from the initiative's settings. */
function repoOf(i: Initiative, card: { repo: string }) {
  return i.repos.find((r) => r.slug === card.repo) ?? null;
}

/**
 * The prompt and the state of a Start, read on one connection. Start and its preview both use it, so the preview shows
 * the prompt Start will send.
 */
async function startPlan(conn: Conn, i: Initiative, cardKey: string) {
  const v = await versionOf(conn, i.id, i.current_version);
  const card = v.doc.blocks.find((b): b is Extract<Block, { kind: 'card' }> => b.kind === 'card' && b.id === cardKey);
  if (!card) throw notFound(`Card ${cardKey}`);
  const facts = await loadFacts(conn, i.id);
  const view = evaluateCards(v.doc, i.milestones_open, facts).find((c) => c.key === cardKey)!;
  const reasons: string[] = [];
  if (view.state === 'delivered') reasons.push('This card is delivered.');
  if (view.state === 'running') reasons.push(`This card is running (${view.phase}).`);
  for (const g of view.gates) if (!g.met) reasons.push(`Open: ${g.label}.`);
  const repo = repoOf(i, card);
  if (!repo) reasons.push(`Repository ${card.repo} is not in the initiative's settings.`);
  const titles = new Map(v.doc.blocks.map((b) => [b.id, b.title ?? ''] as const));
  const merged: MergedDependency[] = card.gates
    .filter((g): g is Extract<typeof g, { kind: 'merged' }> => g.kind === 'merged')
    .map((g) => {
      const ev = evidenceOf(facts.rows.get(`${card.id}|${gateKeyOf(g)}`)?.evidence);
      return {
        key: g.job,
        title: titles.get(g.job) ?? '',
        pr_url: typeof ev?.url === 'string' ? ev.url : null,
        merged_at: typeof ev?.merged_at === 'string' ? ev.merged_at : null,
      };
    });
  const prompt = repo ? buildCardPrompt({ initiative: { key: i.key, title: i.title }, doc: v.doc, version: v.version, card, repo: { slug: repo.slug, path: repo.path, base: repo.base }, merged }) : null;
  if (prompt && prompt.length > MAX_PROMPT) reasons.push(`The prompt is ${prompt.length} characters, over the ${MAX_PROMPT} limit. Shorten the card or its decisions.`);
  return { card, view, reasons, repo, prompt, version: v.version, doc: v.doc, facts };
}

/** What Start would send, and whether it may start now. Over the cap it still starts: the warning only says so. */
export async function previewStart(ctx: Ctx, key: string, cardKey: string) {
  const i = await initiativeByKey(ctx.pool, key);
  const plan = await startPlan(ctx.pool, i, cardKey);
  const running = await runningCardJobs(ctx.pool, i.id);
  const canStart = plan.view.state === 'ready' && plan.repo !== null && plan.prompt !== null && plan.prompt.length <= MAX_PROMPT;
  return {
    card: cardKey,
    state: plan.view.state,
    can_start: canStart,
    reasons: plan.reasons,
    prompt: plan.prompt,
    started_from_version: plan.version,
    repo: plan.repo ? { slug: plan.repo.slug, path: plan.repo.path, base: plan.repo.base } : null,
    cap: { running, cap: i.cap, over: running >= i.cap },
    warning: running >= i.cap ? `${running} implementation jobs from this initiative are running, and the cap is ${i.cap}. Start works anyway.` : null,
  };
}

/**
 * Start from a ready card: one job request with the server's prompt, and the start record that links it to the card. The
 * Client confirms the prompt the preview showed, so the start names that design version, and is refused when it moved.
 */
export async function startCard(ctx: Ctx, key: string, cardKey: string, previewedVersion: number) {
  return tx(ctx, async (conn) => {
    const i = await lockInitiative(conn, key);
    if (i.status !== 'active') throw conflict(`Initiative ${i.key} is ${i.status}.`);
    const plan = await startPlan(conn, i, cardKey);
    if (plan.version !== previewedVersion) throw conflict(`The design is at version ${plan.version}, not ${previewedVersion}, so the prompt changed. Open the card again to see the prompt.`);
    if (plan.view.state !== 'ready') throw conflict(`Card ${cardKey} cannot start: ${plan.reasons.join(' ') || plan.view.state}`);
    if (!plan.repo || !plan.prompt) throw invalid(`Card ${cardKey} names a repository that is not in the initiative's settings.`);
    const queued = await queueRequest(conn, ctx, { mode: 'prompt', prompt: plan.prompt, repoPath: plan.repo.path, baseBranch: plan.repo.base, kind: 'implement' });
    await exec(conn, 'INSERT INTO initiative_card_starts (id, initiative_id, card_key, request_id, started_from_version, started_at) VALUES (?, ?, ?, ?, ?, ?)', [
      newId('cst'),
      i.id,
      cardKey,
      queued.id,
      plan.version,
      ctx.clock.now(),
    ]);
    return { request_id: queued.id, launch_id: queued.launch_id, already_queued: queued.already_queued, started_from_version: plan.version };
  });
}

/** Locks the initiative row for the rest of the transaction; every write to its versions or gates goes through here. */
async function lockInitiative(conn: Conn, key: string): Promise<Initiative> {
  const r = await queryOne(conn, 'SELECT id FROM initiatives WHERE `key` = ? FOR UPDATE', [key]);
  if (!r) throw notFound(`Initiative ${key}`);
  return initiativeByKey(conn, key);
}

/**
 * Writes the next design version for a gate event: an optional PR on the source card, and one status line in the
 * T-status text block (the newest first, twenty at most). The caller holds the initiative lock.
 */
async function writeGateVersion(
  conn: Conn,
  ctx: Ctx,
  i: Initiative,
  o: { trigger: 'event' | 'client_edit'; triggerRef: string; createdBy: string; line: string; source?: { card: string; pr_url: string; merged?: string } },
): Promise<number> {
  const base = await versionOf(conn, i.id, i.current_version);
  const ops: Record<string, unknown>[] = [];
  if (o.source) ops.push({ op: 'update', id: o.source.card, set: { pr: o.source.pr_url, ...(o.source.merged ? { merged: o.source.merged } : {}) } });
  const status = base.doc.blocks.find((b) => b.id === 'T-status');
  const previous = status && status.kind === 'text' && status.body ? String(status.body).split('\n') : [];
  const body = [o.line, ...previous].slice(0, 20).join('\n').slice(0, 20_000);
  ops.push(status ? { op: 'update', id: 'T-status', set: { body } } : { op: 'add', block: { kind: 'text', id: 'T-status', title: 'Status', body } });
  let applied: ReturnType<typeof applyOps>;
  try {
    applied = applyOps(base.doc, ops);
  } catch (e) {
    if (e instanceof DesignError) throw invalid(e.message);
    throw e;
  }
  const version = i.current_version + 1;
  const now = ctx.clock.now();
  await exec(conn, `INSERT INTO initiative_versions (initiative_id, version, doc, changed, trigger_kind, trigger_ref, summary, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    i.id,
    version,
    JSON.stringify(applied.doc),
    JSON.stringify([...applied.changed, ...applied.removed]),
    o.trigger,
    o.triggerRef,
    o.line.slice(0, 1000),
    o.createdBy,
    now,
  ]);
  await exec(conn, 'UPDATE initiatives SET current_version = ?, updated_at = ? WHERE id = ?', [version, now, i.id]);
  return version;
}

/**
 * The Client marks a gate met by hand, with a reason. The mark is a new design version (trigger client_edit) whose status
 * line carries the reason, so the History has the log.
 */
export async function markGate(ctx: Ctx, key: string, cardKey: string, gateKey: string, rawReason: string) {
  const reason = rawReason.trim();
  if (!reason) throw invalid('Give the reason for marking this gate.');
  if (reason.length > 500) throw invalid('The reason is longer than 500 characters.');
  assertNoSecrets(reason);
  return tx(ctx, async (conn) => {
    const i = await lockInitiative(conn, key);
    const v = await versionOf(conn, i.id, i.current_version);
    const card = v.doc.blocks.find((b): b is Extract<Block, { kind: 'card' }> => b.kind === 'card' && b.id === cardKey);
    if (!card) throw notFound(`Card ${cardKey}`);
    const gate = card.gates.find((g) => gateKeyOf(g) === gateKey);
    if (!gate) throw notFound(`Gate ${gateKey} of ${cardKey}`);
    if (gate.kind === 'decision' || gate.kind === 'milestone') throw invalid('A decision or milestone gate follows the design. It cannot be marked by hand.');
    const titles = new Map(v.doc.blocks.map((b) => [b.id, b.title ?? ''] as const));
    const row = await queryOne(conn, 'SELECT id, met_at FROM initiative_gates WHERE initiative_id = ? AND card_key = ? AND gate_key = ? FOR UPDATE', [i.id, cardKey, gateKey]);
    if (row?.met_at) throw conflict('This gate is already met.');
    const now = ctx.clock.now();
    const rowId = row ? String(row.id) : newId('gat');
    if (row) await exec(conn, `UPDATE initiative_gates SET met_at = ?, met_by = 'client', reason = ? WHERE id = ?`, [now, reason, rowId]);
    else await exec(conn, `INSERT INTO initiative_gates (id, initiative_id, card_key, gate_key, met_at, met_by, reason) VALUES (?, ?, ?, ?, ?, 'client', ?)`, [rowId, i.id, cardKey, gateKey, now, reason]);
    const version = await writeGateVersion(conn, ctx, i, {
      trigger: 'client_edit',
      triggerRef: rowId,
      createdBy: 'client',
      line: `Gate marked met by the Client: ${cardKey} waits for ${gateLabel(gate, titles)}. Reason: ${reason}`,
    });
    return { version, gate: gateKey };
  });
}

/**
 * The source of a merged gate: the PR of the job started from that card, from its latest delivery that has a PR. The
 * repository is the card's one in the initiative's settings, and the PR must be in it. Everything the runner runs comes
 * from here.
 */
async function mergedSource(conn: Conn, i: Initiative, doc: Doc, cardKey: string): Promise<Source> {
  const card = doc.blocks.find((b): b is Extract<Block, { kind: 'card' }> => b.kind === 'card' && b.id === cardKey);
  if (!card) return { ok: false, reason: `Card ${cardKey} is not in the design.` };
  const repo = repoOf(i, card);
  if (!repo?.github) return { ok: false, reason: `Repository ${card.repo} has no GitHub slug in the initiative's settings.` };
  const start = (await latestStarts(conn, i.id, cardKey)).get(cardKey);
  const req = start ? await queryOne(conn, 'SELECT job_id FROM job_requests WHERE id = ?', [start.request_id]) : null;
  if (!req?.job_id) return { ok: false, reason: `No job was started from card ${cardKey}.` };
  // The job itself, or a subjob it was split into: Staff may split a card's job, and Seniors then deliver the subjobs.
  // Subjobs each deliver their own PR. One `gh` call checks one PR, so with several the check would look at the latest
  // only, and one merged PR would mark the gate while the others are still open. Refuse; the Client marks the gate by hand.
  // Counted by pull request, not by URL string: one PR reported under two spellings is still one PR.
  const rows = await query(conn, `SELECT DISTINCT pr_url FROM deliveries WHERE job_id IN (SELECT id FROM jobs WHERE id = ? OR parent_job_id = ?) AND pr_url <> ''`, [req.job_id, req.job_id]);
  const prs = new Set(rows.map((row) => {
    const p = parsePrUrl(String(row.pr_url));
    return p ? `${p.slug.toLowerCase()}#${p.number}` : String(row.pr_url);
  }));
  if (prs.size > 1) return { ok: false, reason: `The job of card ${cardKey} has more than one pull request. The automatic merged check covers one, so mark this gate by hand with a reason.` };
  const d = await queryOne(conn, `SELECT pr_url FROM deliveries WHERE job_id IN (SELECT id FROM jobs WHERE id = ? OR parent_job_id = ?) AND pr_url <> '' ORDER BY reported_at DESC LIMIT 1`, [req.job_id, req.job_id]);
  if (!d) return { ok: false, reason: `The job of card ${cardKey} has no delivery with a pull request yet.` };
  const pr = parsePrUrl(String(d.pr_url));
  if (!pr) return { ok: false, reason: `The delivery of card ${cardKey} does not name a GitHub pull request.` };
  if (pr.slug.toLowerCase() !== repo.github.toLowerCase()) return { ok: false, reason: `The pull request of card ${cardKey} is in ${pr.slug}, not in ${repo.github}.` };
  return { ok: true, card: cardKey, pr_url: `https://github.com/${pr.slug}/pull/${pr.number}`, number: pr.number, slug: repo.github };
}

/**
 * Queues a merged check for every open merged gate whose source job has a PR, at most once per GATE_CHECK_MS. Runs in the
 * scheduler tick; no model turn is spent.
 */
export async function queueGateChecks(ctx: Ctx) {
  const now = ctx.clock.now();
  const active = await query(ctx.pool, `SELECT \`key\` FROM initiatives WHERE status = 'active'`);
  for (const { key } of active) {
    const initiative = await initiativeByKey(ctx.pool, String(key));
    const v = await versionOf(ctx.pool, initiative.id, initiative.current_version);
    for (const card of v.doc.blocks) {
      if (card.kind !== 'card') continue;
      for (const g of card.gates) {
        if (g.kind !== 'merged') continue;
        const gateKey = gateKeyOf(g);
        const row = await queryOne(ctx.pool, 'SELECT id, met_at, checked_at, evidence FROM initiative_gates WHERE initiative_id = ? AND card_key = ? AND gate_key = ?', [initiative.id, card.id, gateKey]);
        if (row?.met_at || recentlyChecked(row?.checked_at, now)) continue;
        const src = await mergedSource(ctx.pool, initiative, v.doc, g.job);
        if (!src.ok) {
          // No check ran, so checked_at stays as it is: the first real check must not wait 10 minutes after a delivery.
          // The reason is the gate's evidence under its own key, written only when it changes, so the Jobs tab shows why.
          if (evidenceOf(row?.evidence)?.not_checked === src.reason) continue;
          await tx(ctx, async (conn) => {
            const again = await queryOne(conn, 'SELECT id, met_at FROM initiative_gates WHERE initiative_id = ? AND card_key = ? AND gate_key = ? FOR UPDATE', [initiative.id, card.id, gateKey]);
            if (again?.met_at) return;
            const evidence = JSON.stringify({ not_checked: src.reason });
            if (again) await exec(conn, 'UPDATE initiative_gates SET evidence = ? WHERE id = ?', [evidence, again.id]);
            else await exec(conn, 'INSERT INTO initiative_gates (id, initiative_id, card_key, gate_key, evidence) VALUES (?, ?, ?, ?, ?)', [newId('gat'), initiative.id, card.id, gateKey, evidence]);
          });
          continue;
        }
        const repo = repoOf(initiative, card);
        const rowId = String(row?.id ?? newId('gat'));
        await tx(ctx, async (conn) => {
          const again = await queryOne(conn, 'SELECT met_at, checked_at FROM initiative_gates WHERE id = ? FOR UPDATE', [rowId]);
          if (again?.met_at || recentlyChecked(again?.checked_at, now)) return;
          const pending = await queryOne(conn, `SELECT id FROM launches WHERE kind = 'gate_check' AND run_id = ? AND finished_at IS NULL`, [rowId]);
          if (pending) return;
          if (again) await exec(conn, 'UPDATE initiative_gates SET checked_at = ? WHERE id = ?', [now, rowId]);
          else await exec(conn, 'INSERT INTO initiative_gates (id, initiative_id, card_key, gate_key, checked_at) VALUES (?, ?, ?, ?, ?)', [rowId, initiative.id, card.id, gateKey, now]);
          await exec(conn, `INSERT INTO launches (id, agent_id, kind, run_id, cwd, runtime, requested_at) VALUES (?, NULL, 'gate_check', ?, ?, 'gh', ?)`, [newId('lch'), rowId, repo?.path ?? '', now]);
        });
      }
    }
  }
}

function recentlyChecked(at: unknown, now: Date): boolean {
  const t = at instanceof Date ? at.getTime() : at ? new Date(String(at)).getTime() : NaN;
  return Number.isFinite(t) && now.getTime() - t < GATE_CHECK_MS;
}

/**
 * The runner picks a gate_check launch: the PR is read again from the database now, and the launch is finished without a
 * run when the gate is met, or its source has no PR any more. Returns only the PR number and the repository slug.
 */
export async function gateCheckLaunch(conn: Conn, ctx: Ctx, l: { id: string; run_id: string; cwd: string }) {
  const now = ctx.clock.now();
  const finish = async (result: string) => {
    await exec(conn, 'UPDATE launches SET finished_at = ?, result = ? WHERE id = ?', [now, result, l.id]);
    return null;
  };
  const g = await queryOne(conn, 'SELECT * FROM initiative_gates WHERE id = ?', [l.run_id]);
  if (!g) return finish('cancelled: the gate no longer exists');
  if (g.met_at) return finish('cancelled: the gate is already met');
  const gateKey = String(g.gate_key);
  if (!gateKey.startsWith('merged:')) return finish('failed: not a merged gate');
  const i = await queryOne(conn, 'SELECT * FROM initiatives WHERE id = ?', [g.initiative_id]);
  if (!i) return finish('cancelled: the initiative no longer exists');
  const initiative = await initiativeByKey(conn, String(i.key));
  const v = await versionOf(conn, initiative.id, initiative.current_version);
  const src = await mergedSource(conn, initiative, v.doc, gateKey.slice('merged:'.length));
  if (!src.ok) return finish(`cancelled: ${src.reason}`);
  return { id: l.id, kind: 'gate_check', runtime: 'gh', cwd: l.cwd, pr_number: src.number, repo_slug: src.slug };
}

/**
 * The runner's check finished: its JSON is read, and the gate is met only when GitHub says the PR of the source job is
 * merged with a merge commit. The evidence is stored either way. Anything else is refused without a mark.
 */
export async function recordGateOutput(ctx: Ctx, launchId: string, body: { code: number | null; stdout: string; stderr: string }) {
  const l = await queryOne(ctx.pool, `SELECT id, kind, run_id FROM launches WHERE id = ?`, [launchId]);
  if (!l || l.kind !== 'gate_check') throw notFound(`Gate check ${launchId}`);
  const g0 = await queryOne(ctx.pool, 'SELECT initiative_id FROM initiative_gates WHERE id = ?', [l.run_id]);
  if (!g0) return { ok: true, recorded: false };
  return tx(ctx, async (conn) => {
    const i0 = await queryOne(conn, 'SELECT `key` FROM initiatives WHERE id = ? FOR UPDATE', [g0.initiative_id]);
    if (!i0) return { ok: true, recorded: false };
    const i = await initiativeByKey(conn, String(i0.key));
    const g = await queryOne(conn, 'SELECT * FROM initiative_gates WHERE id = ? FOR UPDATE', [l.run_id]);
    if (!g || g.met_at) return { ok: true, recorded: false };
    const gateKey = String(g.gate_key);
    if (!gateKey.startsWith('merged:')) return { ok: true, recorded: false };
    const now = ctx.clock.now();
    const v = await versionOf(conn, i.id, i.current_version);
    const src = await mergedSource(conn, i, v.doc, gateKey.slice('merged:'.length));
    const checked = { checked_at: now.toISOString() };
    const store = (evidence: Record<string, unknown>) => exec(conn, 'UPDATE initiative_gates SET checked_at = ?, evidence = ? WHERE id = ?', [now, JSON.stringify({ ...checked, ...evidence }), g.id]);
    if (!src.ok) {
      await store({ error: src.reason });
      return { ok: true, recorded: false };
    }
    const out: GateOutput | null = body.code === 0 ? parseGateOutput(body.stdout) : null;
    if (!out) {
      const first = body.stderr.split('\n').find((line) => line.trim()) ?? '';
      await store({ error: body.code === 0 ? 'The check printed no pull request JSON.' : `gh exited with ${body.code}: ${first.slice(0, 300)}` });
      return { ok: true, recorded: false };
    }
    const pr = parsePrUrl(out.url);
    if (!pr || pr.slug.toLowerCase() !== src.slug.toLowerCase() || pr.number !== src.number) {
      await store({ error: 'The check answered for another pull request.' });
      return { ok: true, recorded: false };
    }
    // The PR number from the source job's delivery is the source of truth: the check answers for that PR only (checked above).
    if (!provesMerged(out)) {
      await store({ state: out.state, url: src.pr_url });
      return { ok: true, recorded: false };
    }
    const mergedAt = String(out.mergedAt);
    const oid = out.mergeCommit!.oid;
    await exec(conn, `UPDATE initiative_gates SET met_at = ?, met_by = 'check', checked_at = ?, evidence = ? WHERE id = ?`, [
      now,
      now,
      JSON.stringify({ ...checked, state: out.state, url: src.pr_url, merged_at: mergedAt, merge_commit: oid }),
      g.id,
    ]);
    const day = mergedAt.slice(0, 10);
    const version = await writeGateVersion(conn, ctx, i, {
      trigger: 'event',
      triggerRef: String(g.id),
      createdBy: 'scheduler',
      line: `Gate met by check: ${g.card_key} waits for ${src.card}. PR ${src.pr_url} merged at ${mergedAt}, merge commit ${oid.slice(0, 7)}.`,
      source: { card: src.card, pr_url: src.pr_url, merged: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined },
    });
    return { ok: true, recorded: true, version };
  });
}
