import { tx, type Ctx } from './context.ts';
import { exec, parseJson, query, queryOne, type Conn, type Row } from './db.ts';
import { applyOps, DesignError, MAX_BODY, type Doc, type Block } from './design.ts';
import { checkpointHash, evaluateCards, gateKeyOf, gateLabel, type CardStart, type Facts, type GateRow } from './card-state.ts';
import { buildCardPrompt, type MergedDependency } from './card-prompt.ts';
import { parseGateOutput, parsePrUrl, provesMerged, type GateOutput } from './gate-check.ts';
import { adoptCheckpointHashes, hasLegacyMark, initiativeByKey, versionOf } from './initiatives.ts';
import { MAX_PROMPT, queueRequest } from './job-requests.ts';
import { assertNoSecrets, conflict, invalid, newId, notFound } from './lib.ts';

/**
 * Initiative jobs and gates (docs/plans/initiative-room.md, phase 2): the one gate evaluator's facts, Start from a job
 * card, manual marks, milestone starts and the runner's merged check. The design itself is changed here only by a new
 * version whose trigger is a check (`event`) or the Client's mark or milestone start (`client_edit`); a Confirm card is
 * never involved. A check changes only the T-status text; the PR and the merge are kept in the gate's evidence.
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
  const gateRows = await query(conn, 'SELECT card_key, gate_key, met_at, met_by, reason, evidence, checkpoint_hash FROM initiative_gates WHERE initiative_id = ?', [initiativeId]);
  const rows = new Map<string, GateRow>(
    gateRows.map((r) => [`${r.card_key}|${r.gate_key}`, { met_at: iso(r.met_at), met_by: r.met_by ?? null, reason: r.reason ?? null, evidence: evidenceOf(r.evidence), checkpoint_hash: r.checkpoint_hash ?? null }]),
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

/**
 * The room's Jobs tab: every card with its state, its gates and the waves they sit in, for the current version. The page
 * polls it every 30 seconds, so the write lock is taken only while a client_step mark made before checkpoint_hash existed
 * still has a hash to adopt (hasLegacyMark); the first read adopts it under the lock.
 */
export async function cardJobs(ctx: Ctx, key: string) {
  const first = await initiativeByKey(ctx.pool, key);
  const firstVersion = await versionOf(ctx.pool, first.id, first.current_version);
  if (!(await hasLegacyMark(ctx.pool, first.id, firstVersion.doc))) return cardsView(ctx.pool, first, firstVersion);
  return tx(ctx, async (conn) => {
    const i = await lockInitiative(conn, key);
    const v = await versionOf(conn, i.id, i.current_version);
    await adoptCheckpointHashes(conn, i.id, v.doc);
    return cardsView(conn, i, v);
  });
}

async function cardsView(conn: Conn, i: Initiative, v: Awaited<ReturnType<typeof versionOf>>) {
  const cards = evaluateCards(v.doc, i.milestones_started, await loadFacts(conn, i.id));
  const waves = v.doc.blocks.filter((b): b is Extract<Block, { kind: 'wave' }> => b.kind === 'wave').map((w) => ({ id: w.id, title: w.title, when: w.when }));
  return { key: i.key, version: v.version, current_version: i.current_version, cap: i.cap, milestones_started: i.milestones_started, running: await runningCardJobs(conn, i.id), waves, cards };
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
  const view = evaluateCards(v.doc, i.milestones_started, facts).find((c) => c.key === cardKey)!;
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
      const row = facts.rows.get(`${card.id}|${gateKeyOf(g)}`);
      // Only a check's evidence proves a merge. A gate the Client marked by hand may carry an earlier check's URL, which
      // can be an open pull request, so the prompt then says the Client marked it and gives no PR.
      const ev = row?.met_by === 'check' ? evidenceOf(row.evidence) : null;
      return {
        key: g.job,
        title: titles.get(g.job) ?? '',
        pr_url: typeof ev?.url === 'string' ? ev.url : null,
        merged_at: typeof ev?.merged_at === 'string' ? ev.merged_at : null,
      };
    });
  const prompt = repo ? buildCardPrompt({ initiative: { key: i.key, title: i.title }, doc: v.doc, version: v.version, card, repo: { slug: repo.slug, path: repo.path, base: repo.base }, merged }) : null;
  if (prompt && prompt.length > MAX_PROMPT) reasons.push(`The prompt is ${prompt.length} characters, over the ${MAX_PROMPT} limit. Shorten the card, its decisions, or the design's contract list (every contract is listed by id and title in every prompt).`);
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
    // A dependent's merged mark that a check made was checked against the job this start may replace. It is cleared, so
    // the check runs again against the new job. An open dependent also loses its refusal and its cooldown, which were
    // read against the old job. Marks the Client made by hand stay.
    await exec(conn, `UPDATE initiative_gates SET met_at = NULL, met_by = NULL, checked_at = NULL, evidence = NULL WHERE initiative_id = ? AND gate_key = ? AND (met_by = 'check' OR met_at IS NULL)`, [i.id, `merged:${cardKey}`]);
    return { request_id: queued.id, launch_id: queued.launch_id, already_queued: queued.already_queued, started_from_version: plan.version };
  });
}

/**
 * Clears the merged marks that checks made for the cards whose latest start is this job. Only the latest start counts,
 * the way mergedSource reads it, so an older start that a retry or a new start replaced does not clear a current card.
 * The job was reopened, so it is not merged now, and a dependent must not stay met on the strength of an old check.
 */
export async function clearCheckMarksForJob(conn: Conn, jobId: string) {
  // The requests of the job and the earlier requests of its retry chain: a card's start can be any of them.
  const chain = new Set((await query(conn, 'SELECT id FROM job_requests WHERE job_id = ?', [jobId])).map((r) => String(r.id)));
  let frontier = [...chain];
  while (frontier.length) {
    const parents = (await query(conn, `SELECT retry_of FROM job_requests WHERE id IN (${frontier.map(() => '?').join(', ')}) AND retry_of IS NOT NULL`, frontier)).map((r) => String(r.retry_of)).filter((id) => !chain.has(id));
    for (const id of parents) chain.add(id);
    frontier = parents;
  }
  if (!chain.size) return;
  // Only the initiatives of those starts, in id order, so a reopen does not lock every initiative that has a start.
  const initiativeIds = (await query(conn, `SELECT DISTINCT initiative_id FROM initiative_card_starts WHERE request_id IN (${[...chain].map(() => '?').join(', ')}) ORDER BY initiative_id`, [...chain])).map((r) => String(r.initiative_id));
  for (const initiativeId of initiativeIds) {
    // The initiative row is locked as lockInitiative locks it, before the gate rows are written.
    await queryOne(conn, 'SELECT id FROM initiatives WHERE id = ? FOR UPDATE', [initiativeId]);
    for (const start of (await latestStarts(conn, initiativeId)).values()) {
      const req = await queryOne(conn, 'SELECT job_id FROM job_requests WHERE id = ?', [start.request_id]);
      if (String(req?.job_id ?? '') !== jobId) continue;
      await exec(conn, `UPDATE initiative_gates SET met_at = NULL, met_by = NULL, checked_at = NULL, evidence = NULL WHERE initiative_id = ? AND gate_key = ? AND (met_by = 'check' OR met_at IS NULL)`, [initiativeId, `merged:${start.card_key}`]);
    }
  }
}

/**
 * Refuses a retry of a failed start whose card is no longer ready, for example because a gate of the card was reopened
 * after the failure. The retry is the same start, but the gates are read again, as a Start reads them. The read is not
 * under the initiative lock, which a Start takes: taking it here would order the two locks the other way round.
 */
export async function assertRetryStillReady(conn: Conn, requestId: string) {
  let root = requestId;
  for (let hops = 0; hops < 50; hops++) {
    const r = await queryOne(conn, 'SELECT retry_of FROM job_requests WHERE id = ?', [root]);
    if (!r?.retry_of) break;
    root = String(r.retry_of);
  }
  const start = await queryOne(conn, 'SELECT initiative_id, card_key FROM initiative_card_starts WHERE request_id = ?', [root]);
  if (!start) return;
  const initiative = await queryOne(conn, 'SELECT `key` FROM initiatives WHERE id = ?', [start.initiative_id]);
  if (!initiative) return;
  const i = await initiativeByKey(conn, String(initiative.key));
  if (i.status !== 'active') throw conflict(`Initiative ${i.key} is ${i.status}.`);
  const plan = await startPlan(conn, i, String(start.card_key));
  // A running card is left to the refusals of the retry itself (an identical start already queued, a live start).
  if (plan.view.state !== 'ready' && plan.view.state !== 'running') throw conflict(`Card ${start.card_key} is ${plan.view.state}, not ready, so the failed start is not retried. ${plan.reasons.join(' ')}`.trim());
}

/** Locks the initiative row for the rest of the transaction; every write to its versions or gates goes through here. */
async function lockInitiative(conn: Conn, key: string): Promise<Initiative> {
  const r = await queryOne(conn, 'SELECT id FROM initiatives WHERE `key` = ? FOR UPDATE', [key]);
  if (!r) throw notFound(`Initiative ${key}`);
  return initiativeByKey(conn, key);
}

/**
 * Writes the next design version for a gate event: one status line in the T-status text block (the newest first; no line
 * is ever cut). A line that would take the block past its size limit is
 * not written, and statusWritten is false so the caller can record that in the gate's evidence. The version is written
 * either way. The caller holds the initiative lock, which also makes the read of the block and its write one transaction.
 */
async function writeGateVersion(
  conn: Conn,
  ctx: Ctx,
  i: Initiative,
  o: { trigger: 'event' | 'client_edit'; triggerRef: string; createdBy: string; line: string },
): Promise<{ version: number; statusWritten: boolean }> {
  const base = await versionOf(conn, i.id, i.current_version);
  const ops: Record<string, unknown>[] = [];
  const status = base.doc.blocks.find((b) => b.id === 'T-status');
  const previous = status && status.kind === 'text' && status.body ? String(status.body).split('\n') : [];
  const body = [o.line, ...previous].join('\n');
  const statusWritten = body.length <= MAX_BODY;
  if (statusWritten) ops.push(status ? { op: 'update', id: 'T-status', set: { body } } : { op: 'add', block: { kind: 'text', id: 'T-status', title: 'Status', body } });
  // With nothing to change (a status line that did not fit) the version keeps the design as it was; applyOps needs an op.
  let applied: ReturnType<typeof applyOps> = { doc: base.doc, changed: [], removed: [] };
  if (ops.length) {
    try {
      applied = applyOps(base.doc, ops);
    } catch (e) {
      if (e instanceof DesignError) throw invalid(e.message);
      throw e;
    }
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
  return { version, statusWritten };
}

/** Records in a gate's evidence that its status line did not fit in the T-status block. */
async function noteSkippedStatus(conn: Conn, rowId: string): Promise<void> {
  await exec(conn, `UPDATE initiative_gates SET evidence = JSON_SET(COALESCE(evidence, JSON_OBJECT()), '$.status_line_skipped', true) WHERE id = ?`, [rowId]);
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
    if (i.status !== 'active') throw conflict(`Initiative ${i.key} is ${i.status}.`);
    const v = await versionOf(conn, i.id, i.current_version);
    const card = v.doc.blocks.find((b): b is Extract<Block, { kind: 'card' }> => b.kind === 'card' && b.id === cardKey);
    if (!card) throw notFound(`Card ${cardKey}`);
    const gate = card.gates.find((g) => gateKeyOf(g) === gateKey);
    if (!gate) throw notFound(`Gate ${gateKey} of ${cardKey}`);
    if (gate.kind === 'decision' || gate.kind === 'milestone') throw invalid('A decision or milestone gate follows the design. It cannot be marked by hand.');
    const titles = new Map(v.doc.blocks.map((b) => [b.id, b.title ?? ''] as const));
    const row = await queryOne(conn, 'SELECT id, met_at, checkpoint_hash FROM initiative_gates WHERE initiative_id = ? AND card_key = ? AND gate_key = ? FOR UPDATE', [i.id, cardKey, gateKey]);
    // A client_step mark keeps the hash of its checkpoint now, so a later change to those steps re-opens it.
    const cp = gate.kind === 'client_step' ? v.doc.blocks.find((b): b is Extract<Block, { kind: 'checkpoint' }> => b.kind === 'checkpoint' && b.id === gate.ref) : undefined;
    const hash = cp ? checkpointHash(cp.steps) : null;
    const reopened = Boolean(row?.met_at && row.checkpoint_hash && hash && row.checkpoint_hash !== hash);
    if (row?.met_at && !reopened) throw conflict('This gate is already met.');
    const now = ctx.clock.now();
    const rowId = row ? String(row.id) : newId('gat');
    if (row) await exec(conn, `UPDATE initiative_gates SET met_at = ?, met_by = 'client', reason = ?, checkpoint_hash = ? WHERE id = ?`, [now, reason, hash, rowId]);
    else await exec(conn, `INSERT INTO initiative_gates (id, initiative_id, card_key, gate_key, met_at, met_by, reason, checkpoint_hash) VALUES (?, ?, ?, ?, ?, 'client', ?, ?)`, [rowId, i.id, cardKey, gateKey, now, reason, hash]);
    const { version, statusWritten } = await writeGateVersion(conn, ctx, i, {
      trigger: 'client_edit',
      triggerRef: rowId,
      createdBy: 'client',
      line: `Gate marked met by the Client: ${cardKey} waits for ${gateLabel(gate, titles)}. Reason: ${reason}`,
    });
    if (!statusWritten) await noteSkippedStatus(conn, rowId);
    return { version, gate: gateKey };
  });
}

/**
 * The Client starts a milestone: the milestone gates that name it are met from then on. The initiative's started
 * milestones change, and the design gets a version (trigger client_edit) whose status line says so.
 */
export async function startMilestone(ctx: Ctx, key: string, ref: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]{0,23}$/.test(ref)) throw invalid(`Milestone ${ref} is not a milestone name.`);
  return tx(ctx, async (conn) => {
    const i = await lockInitiative(conn, key);
    if (i.status !== 'active') throw conflict(`Initiative ${i.key} is ${i.status}.`);
    const v = await versionOf(conn, i.id, i.current_version);
    const waits = v.doc.blocks.some((b) => b.kind === 'card' && b.gates.some((g) => g.kind === 'milestone' && g.ref === ref));
    if (!waits) throw invalid(`No card waits for milestone ${ref}.`);
    if (i.milestones_started.includes(ref)) throw conflict(`Milestone ${ref} is already started.`);
    if (i.milestones_started.length >= 20) throw conflict('The initiative already has 20 started milestones.');
    const milestones = [...i.milestones_started, ref];
    const now = ctx.clock.now();
    await exec(conn, 'UPDATE initiatives SET milestones_started = ?, updated_at = ? WHERE id = ?', [JSON.stringify(milestones), now, i.id]);
    const { version } = await writeGateVersion(conn, ctx, { ...i, milestones_started: milestones }, {
      trigger: 'client_edit',
      triggerRef: `milestone:${ref}`,
      createdBy: 'client',
      line: `Milestone ${ref} started by the Client. Its milestone gates are met from now on.`,
    });
    return { version, milestone: ref };
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
  // Staff may split a card's job, and Seniors then deliver the subjobs, each with its own PR. Until every subjob has
  // finished, a PR that is already merged does not mean the card is delivered, so the check waits for them all.
  const unfinished = await queryOne(conn, `SELECT id FROM jobs WHERE parent_job_id = ? AND status NOT IN ('done', 'cancelled') LIMIT 1`, [req.job_id]);
  if (unfinished) return { ok: false, reason: `The job of card ${cardKey} has a subjob that is not finished. The check waits until every subjob is done or cancelled.` };
  // A reopened job is delivering again, so the PR of its last delivery is not the card's delivery, even when it is still
  // merged. The check waits until a delivery is reported after each reopen of the card's jobs.
  // A reopen of a live job needs a delivery of that same job, so a delivery of another job does not satisfy it. A cancelled
  // job cannot deliver again, so its reopen needs a delivery of a live job of the card after the reopen. A root reopened
  // and then cancelled therefore keeps its gate refused, and so does a subjob whose root has not delivered since.
  const reopened = await queryOne(conn, `SELECT e.id FROM events e JOIN jobs ej ON ej.id = e.job_id WHERE e.type = 'job.reopened' AND (ej.id = ? OR ej.parent_job_id = ?) AND NOT EXISTS (SELECT 1 FROM deliveries d JOIN jobs dj ON dj.id = d.job_id WHERE (dj.id = ? OR dj.parent_job_id = ?) AND d.reported_at > e.created_at AND (d.job_id = e.job_id OR (ej.status = 'cancelled' AND dj.status <> 'cancelled'))) LIMIT 1`, [req.job_id, req.job_id, req.job_id, req.job_id]);
  if (reopened) return { ok: false, reason: `The job of card ${cardKey} was reopened after its last delivery. The check waits for a delivery reported after the reopen.` };
  // The job itself, or a subjob it was split into. One `gh` call checks one PR, so with several the check would look at
  // the latest only, and one merged PR would mark the gate while the others are still open. Refuse; the Client marks the gate by hand.
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

type CardBlock = Extract<Block, { kind: 'card' }>;
type MergedGate = Extract<CardBlock['gates'][number], { kind: 'merged' }>;
/** A merged gate that is due for its check, with what the check reads: its design, its card and its gate row. */
type DueCheck = { initiative: Initiative; doc: Doc; card: CardBlock; gate: MergedGate; gateKey: string; row: Row | undefined; at: number };

/**
 * Queues a merged check for every open merged gate whose source job has a PR, at most once per GATE_CHECK_MS. Runs in the
 * scheduler tick; no model turn is spent.
 */
export async function queueGateChecks(ctx: Ctx) {
  // One check in flight, and one queued per pass. The runner runs a check inside its launch loop (scripts/runner.ts,
  // tick), so checks queued in bulk would hold back every other launch, Staff starts included, for a minute each.
  if (await queryOne(ctx.pool, `SELECT id FROM launches WHERE kind = 'gate_check' AND finished_at IS NULL LIMIT 1`)) return;
  const now = ctx.clock.now();
  // The open merged gates that are due, across the active initiatives. The gate rows are read once per initiative.
  const due: DueCheck[] = [];
  const active = await query(ctx.pool, `SELECT \`key\` FROM initiatives WHERE status = 'active'`);
  for (const { key } of active) {
    const initiative = await initiativeByKey(ctx.pool, String(key));
    const v = await versionOf(ctx.pool, initiative.id, initiative.current_version);
    const rows = new Map((await query(ctx.pool, 'SELECT id, card_key, gate_key, met_at, checked_at, evidence FROM initiative_gates WHERE initiative_id = ?', [initiative.id])).map((r) => [`${r.card_key}|${r.gate_key}`, r] as const));
    for (const card of v.doc.blocks) {
      if (card.kind !== 'card') continue;
      for (const g of card.gates) {
        if (g.kind !== 'merged') continue;
        const gateKey = gateKeyOf(g);
        const row = rows.get(`${card.id}|${gateKey}`);
        if (row?.met_at || recentlyChecked(row?.checked_at, now)) continue;
        due.push({ initiative, doc: v.doc, card, gate: g, gateKey, row, at: timeOf(row?.checked_at) });
      }
    }
  }
  // The least recently checked goes first, and a gate never checked goes before all of them. In document order, a check
  // that takes a minute would let the first gates come due again before the last one was reached, so the last never ran.
  due.sort((a, b) => a.at - b.at);
  for (const { initiative, doc, card, gate: g, gateKey, row } of due) {
    const src = await mergedSource(ctx.pool, initiative, doc, g.job);
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
    let queued = false;
    await tx(ctx, async (conn) => {
      const again = await queryOne(conn, 'SELECT met_at, checked_at FROM initiative_gates WHERE id = ? FOR UPDATE', [rowId]);
      if (again?.met_at || recentlyChecked(again?.checked_at, now)) return;
      const pending = await queryOne(conn, `SELECT id FROM launches WHERE kind = 'gate_check' AND run_id = ? AND finished_at IS NULL`, [rowId]);
      if (pending) return;
      // A refusal left by an earlier pass is dropped now, so the Jobs tab does not show it while the check is queued.
      if (again) await exec(conn, `UPDATE initiative_gates SET checked_at = ?, evidence = IF(JSON_CONTAINS_PATH(evidence, 'one', '$.not_checked'), NULL, evidence) WHERE id = ?`, [now, rowId]);
      else await exec(conn, 'INSERT INTO initiative_gates (id, initiative_id, card_key, gate_key, checked_at) VALUES (?, ?, ?, ?, ?)', [rowId, initiative.id, card.id, gateKey, now]);
      await exec(conn, `INSERT INTO launches (id, agent_id, kind, run_id, cwd, runtime, requested_at) VALUES (?, NULL, 'gate_check', ?, ?, 'gh', ?)`, [newId('lch'), rowId, repo?.path ?? '', now]);
      queued = true;
    });
    if (queued) return;
  }
}

/** A stored checked_at as milliseconds, or 0 when there is none. */
function timeOf(at: unknown): number {
  const t = at instanceof Date ? at.getTime() : at ? new Date(String(at)).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

function recentlyChecked(at: unknown, now: Date): boolean {
  const t = timeOf(at);
  return t > 0 && now.getTime() - t < GATE_CHECK_MS;
}

/** Whether the design still has this merged gate on this card. A revision may have removed it after the check was queued. */
function mergedGateInDesign(doc: Doc, cardKey: string, gateKey: string): boolean {
  return doc.blocks.some((b) => b.kind === 'card' && b.id === cardKey && b.gates.some((g) => g.kind === 'merged' && gateKeyOf(g) === gateKey));
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
  if (!mergedGateInDesign(v.doc, String(g.card_key), gateKey)) return finish('cancelled: the gate is no longer in the design');
  const src = await mergedSource(conn, initiative, v.doc, gateKey.slice('merged:'.length));
  if (!src.ok) {
    // The reason is shown on the gate now, in the same transaction. checked_at is cleared, because no check ran: the queue
    // set it, and a kept value would hold back the next check for GATE_CHECK_MS. The met_at guard keeps a mark that a
    // Client made after the read above.
    await exec(conn, 'UPDATE initiative_gates SET checked_at = NULL, evidence = ? WHERE id = ? AND met_at IS NULL', [JSON.stringify({ not_checked: src.reason }), g.id]);
    return finish(`cancelled: ${src.reason}`);
  }
  // The PR this check is for. recordGateOutput discards the answer when the source has moved to another PR while gh ran.
  await exec(conn, 'UPDATE launches SET source_pr = ? WHERE id = ?', [sourceKey(src.slug, src.number), l.id]);
  return { id: l.id, kind: 'gate_check', runtime: 'gh', cwd: l.cwd, pr_number: src.number, repo_slug: src.slug };
}

/** The identity of a pull request in a launch and in a comparison: the repository and the number. */
function sourceKey(slug: string, number: number) {
  return `${slug.toLowerCase()}#${number}`;
}

/**
 * The runner's check finished: its JSON is read, and the gate is met only when GitHub says the PR of the source job is
 * merged with a merge commit. The evidence is stored either way. Anything else is refused without a mark.
 */
export async function recordGateOutput(ctx: Ctx, launchId: string, body: { code: number | null; stdout: string; stderr: string }) {
  const l = await queryOne(ctx.pool, `SELECT id, kind, run_id, source_pr FROM launches WHERE id = ?`, [launchId]);
  if (!l || l.kind !== 'gate_check') throw notFound(`Gate check ${launchId}`);
  const g0 = await queryOne(ctx.pool, 'SELECT initiative_id FROM initiative_gates WHERE id = ?', [l.run_id]);
  if (!g0) return { ok: true, recorded: false };
  return tx(ctx, async (conn) => {
    const i0 = await queryOne(conn, 'SELECT `key` FROM initiatives WHERE id = ? FOR UPDATE', [g0.initiative_id]);
    if (!i0) return { ok: true, recorded: false };
    const i = await initiativeByKey(conn, String(i0.key));
    if (i.status !== 'active') return { ok: true, recorded: false };
    const g = await queryOne(conn, 'SELECT * FROM initiative_gates WHERE id = ? FOR UPDATE', [l.run_id]);
    if (!g || g.met_at) return { ok: true, recorded: false };
    const gateKey = String(g.gate_key);
    if (!gateKey.startsWith('merged:')) return { ok: true, recorded: false };
    const now = ctx.clock.now();
    const v = await versionOf(conn, i.id, i.current_version);
    // A revision may have removed the card or its gate while the check ran. Nothing is recorded for it, so a gate added
    // again later cannot inherit this answer.
    if (!mergedGateInDesign(v.doc, String(g.card_key), gateKey)) return { ok: true, recorded: false };
    const src = await mergedSource(conn, i, v.doc, gateKey.slice('merged:'.length));
    const checked = { checked_at: now.toISOString() };
    const store = (evidence: Record<string, unknown>) => exec(conn, 'UPDATE initiative_gates SET checked_at = ?, evidence = ? WHERE id = ?', [now, JSON.stringify({ ...checked, ...evidence }), g.id]);
    if (!src.ok) {
      // The source is refused now (a reopen, or a second PR delivered meanwhile). The answer is about a source that is no
      // longer the card's, so no checked time is kept: the gate gets no cooldown, and the reason is shown.
      await exec(conn, 'UPDATE initiative_gates SET checked_at = NULL, evidence = ? WHERE id = ?', [JSON.stringify({ not_checked: src.reason }), g.id]);
      return { ok: true, recorded: false };
    }
    // The launch checked the PR it picked. When the card's source is another PR now, the answer, even a failure, is about a
    // source that is gone. It is discarded with no checked time, so the check of the current source runs at the next pass.
    // A launch without a stored source (made before migration 057) is compared with the current source, as it was before.
    if (l.source_pr && String(l.source_pr) !== sourceKey(src.slug, src.number)) {
      await exec(conn, 'UPDATE initiative_gates SET checked_at = NULL, evidence = NULL WHERE id = ?', [g.id]);
      return { ok: true, recorded: false };
    }
    const out: GateOutput | null = body.code === 0 ? parseGateOutput(body.stdout) : null;
    if (!out) {
      const first = body.stderr.split('\n').find((line) => line.trim()) ?? '';
      await store({ error: body.code === 0 ? 'The check printed no pull request JSON.' : `gh exited with ${body.code}: ${first.slice(0, 300)}` });
      return { ok: true, recorded: false };
    }
    const pr = parsePrUrl(out.url);
    const otherPr = !!pr && (pr.slug.toLowerCase() !== src.slug.toLowerCase() || pr.number !== src.number);
    // A launch from before migration 057 has no stored source, so a source that moved while gh ran cannot be told apart from
    // a wrong answer here. The answer is discarded with no checked time, as for a stored source above, so the current source
    // is checked at the next pass. A launch with a stored source that still matches keeps the error for a wrong answer.
    if (otherPr && !l.source_pr) {
      await exec(conn, 'UPDATE initiative_gates SET checked_at = NULL, evidence = NULL WHERE id = ?', [g.id]);
      return { ok: true, recorded: false };
    }
    if (!pr || otherPr) {
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
    const { version, statusWritten } = await writeGateVersion(conn, ctx, i, {
      trigger: 'event',
      triggerRef: String(g.id),
      createdBy: 'scheduler',
      line: `Gate met by check: ${g.card_key} waits for ${src.card}. PR ${src.pr_url} merged at ${mergedAt}, merge commit ${oid.slice(0, 7)}.`,
    });
    if (!statusWritten) await noteSkippedStatus(conn, String(g.id));
    return { ok: true, recorded: true, version };
  });
}
