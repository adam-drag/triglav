import { tx, type Ctx } from './context.ts';
import { exec, query, queryOne, withTx, type Conn } from './db.ts';
import { emit } from './events.ts';
import { invalid, notFound } from './lib.ts';

/**
 * The model and effort the Client wants for each role. The orchestrator never starts agents, so these
 * are handed out where agents get started: in spawn tickets for Seniors and reviewers, and as launch
 * commands on the dashboard for Staff and researchers. Changes apply to agents started afterwards.
 */
export interface RoleModel {
  role: string;
  runtime: string;
  model: string;
  effort: string;
  updated_at: Date;
}

// These values end up in shell commands the Client copies, so keep them to plain identifiers.
export const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const RUNTIME_LABELS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** The choice Triglav makes for a role when only one of the two CLIs is on the machine. The Client can still save others. */
const FALLBACK: Record<string, Record<string, { model: string; effort: string }>> = {
  'claude-code': {
    staff: { model: 'claude-opus-5-5', effort: 'high' },
    senior: { model: 'claude-sonnet-5-5', effort: 'high' },
    reviewer: { model: 'claude-sonnet-5-5', effort: 'high' },
    researcher: { model: 'claude-opus-5-5', effort: 'high' },
  },
  codex: {
    staff: { model: 'gpt-6.1-sol', effort: 'high' },
    senior: { model: 'gpt-6.1-sol', effort: 'high' },
    reviewer: { model: 'gpt-6.1-sol', effort: 'high' },
    researcher: { model: 'gpt-6.1-sol', effort: 'medium' },
  },
};

// ---------------------------------------------------------------- what is on the machine

/** The runner reports every few minutes. A report older than this is not trusted: the runner may be off, the machine changed. */
const REPORT_FRESH_MIN = 15;

/** A model the CLI itself lists, with the efforts it accepts. */
export type CatalogModel = { id: string; label: string; efforts: string[] };
export type Detected = { known: boolean; checked_at: Date | null; runtimes: { runtime: string; label: string; available: boolean; version: string | null; models: CatalogModel[] }[] };

/** The runner's report: for each CLI its version and models, or null when it is not on the machine. Replaces the last report. */
export async function recordHostRuntimes(ctx: Ctx, found: Record<string, { version: string; models: CatalogModel[] } | null>) {
  const at = ctx.clock.now();
  await withTx(ctx.pool, async (conn) => {
    await exec(conn, `DELETE FROM host_runtimes`);
    for (const [runtime, f] of Object.entries(found)) {
      await exec(conn, `INSERT INTO host_runtimes (runtime, available, version, models, checked_at) VALUES (?, ?, ?, ?, ?)`, [runtime, f ? 1 : 0, f?.version.slice(0, 100) ?? null, f ? JSON.stringify(f.models) : null, at]);
    }
  });
}

const parseModels = (v: unknown): CatalogModel[] => (typeof v === 'string' ? JSON.parse(v) : Array.isArray(v) ? (v as CatalogModel[]) : []);

/** `known` is false until the runner has reported, and again when its report is stale: then nothing is assumed missing. */
export async function detectedRuntimes(ctx: Ctx, conn: Conn = ctx.pool): Promise<Detected> {
  const rows = await query(conn, `SELECT runtime, available, version, models, checked_at FROM host_runtimes ORDER BY runtime`);
  const checked = rows.length ? new Date(Math.max(...rows.map((r) => new Date(r.checked_at).getTime()))) : null;
  return {
    known: !!checked && ctx.clock.now().getTime() - checked.getTime() < REPORT_FRESH_MIN * 60_000,
    checked_at: checked,
    runtimes: rows.map((r) => ({ runtime: r.runtime as string, label: RUNTIME_LABELS[r.runtime as string] ?? (r.runtime as string), available: !!r.available, version: (r.version as string | null) ?? null, models: parseModels(r.models) })),
  };
}

/**
 * The runtime to use when `wanted` was asked for: `wanted` itself, unless the machine is known not to have it and has
 * exactly one other CLI. Runtimes Triglav cannot detect pass through.
 */
export function usableRuntime(det: Detected, wanted: string): string {
  if (!det.known || !(wanted in RUNTIME_LABELS)) return wanted;
  const present = det.runtimes.filter((r) => r.available).map((r) => r.runtime);
  return present.includes(wanted) || present.length !== 1 ? wanted : present[0];
}

/** The model and effort to use for a role in `runtime`: Triglav's own choice for that CLI. */
export const fallbackFor = (runtime: string, role: string) => FALLBACK[runtime]?.[role] ?? null;

export type EffectiveRoleModel = RoleModel & { replaces: { runtime: string; model: string; effort: string } | null };

/** What an agent of the role is started with now: the saved setting, or the detected CLI's choice when the saved one is not installed. */
export function effective(det: Detected, m: RoleModel): EffectiveRoleModel {
  const runtime = usableRuntime(det, m.runtime);
  const fb = runtime === m.runtime ? null : fallbackFor(runtime, m.role);
  if (!fb) return { ...m, replaces: null };
  return { ...m, runtime, model: fb.model, effort: fb.effort, replaces: { runtime: m.runtime, model: m.model, effort: m.effort } };
}

export async function effectiveRoleModel(ctx: Ctx, conn: Conn, role: string): Promise<EffectiveRoleModel | null> {
  const m = await roleModel(conn, role);
  return m ? effective(await detectedRuntimes(ctx, conn), m) : null;
}

export async function listRoleModels(conn: Conn): Promise<RoleModel[]> {
  return (await query(conn, `SELECT * FROM role_models ORDER BY FIELD(role, 'staff', 'senior', 'reviewer', 'researcher')`)) as RoleModel[];
}

/**
 * How a Senior reviews a PR before it reports delivery. `auto`: the Senior uses the Copilot loop when Copilot has reviewed
 * PRs in this repository, and CI alone when it has not. `copilot`: the loop is required, and a delivery that skips it is
 * refused. `ci_only`: no Copilot review; CI on the head commit is the evidence.
 */
export const REVIEW_MODES = ['auto', 'copilot', 'ci_only'] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export async function reviewMode(conn: Conn): Promise<ReviewMode> {
  const v = (await queryOne(conn, `SELECT value FROM settings WHERE name = 'review_mode'`))?.value as string | undefined;
  return (REVIEW_MODES as readonly string[]).includes(v ?? '') ? (v as ReviewMode) : 'auto';
}

export async function setReviewMode(ctx: Ctx, mode: string) {
  if (!(REVIEW_MODES as readonly string[]).includes(mode)) throw invalid(`The review mode must be one of ${REVIEW_MODES.join(', ')}.`);
  return tx(ctx, async (conn) => {
    await exec(conn, `INSERT INTO settings (name, value, updated_at) VALUES ('review_mode', ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`, [mode, ctx.clock.now()]);
    await emit(conn, ctx, { type: 'review_mode.changed', actor: 'client', payload: { mode } });
    return { review_mode: mode };
  });
}

/** The Models page: each role as saved, and what Triglav uses instead where the saved CLI is not on the machine. */
export async function roleModelsView(ctx: Ctx) {
  const det = await detectedRuntimes(ctx);
  return { detected: det, roles: (await listRoleModels(ctx.pool)).map((m) => effective(det, m)), review_mode: await reviewMode(ctx.pool) };
}

export async function roleModel(conn: Conn, role: string): Promise<RoleModel | null> {
  return ((await queryOne(conn, `SELECT * FROM role_models WHERE role = ?`, [role])) as RoleModel | null) ?? null;
}

/** When the runner has listed the models of a CLI, only those can be saved for it, with an effort the model accepts. */
export function checkAgainstCatalog(det: Detected, input: { runtime: string; model: string; effort: string }) {
  const cli = det.known ? det.runtimes.find((r) => r.runtime === input.runtime) : undefined;
  if (!cli) return;
  if (!cli.available) throw invalid(`${cli.label} was not found on this machine.`);
  if (!cli.models.length) return;
  const m = cli.models.find((x) => x.id === input.model);
  if (!m) throw invalid(`${cli.label} does not offer the model "${input.model}" on this machine. It offers: ${cli.models.map((x) => x.id).join(', ')}.`);
  if (!m.efforts.includes(input.effort)) throw invalid(`${m.label} does not accept the effort "${input.effort}". It accepts: ${m.efforts.join(', ')}.`);
}

export async function updateRoleModel(ctx: Ctx, role: string, input: { runtime: string; model: string; effort: string }) {
  for (const [field, value] of Object.entries(input)) {
    if (!SAFE.test(value)) throw invalid(`${field} may only contain letters, digits, ".", "_", ":" and "-", and must start with a letter or digit.`);
  }
  return tx(ctx, async (conn) => {
    const current = await roleModel(conn, role);
    if (!current) throw notFound(`Role ${role}`);
    checkAgainstCatalog(await detectedRuntimes(ctx, conn), input);
    await exec(conn, `UPDATE role_models SET runtime = ?, model = ?, effort = ?, updated_at = ? WHERE role = ?`, [input.runtime, input.model, input.effort, ctx.clock.now(), role]);
    await emit(conn, ctx, { type: 'role_model.changed', actor: 'client', payload: { role, ...input } });
    return roleModel(conn, role);
  });
}

/** What Staff needs to start an agent with the configured model in its own CLI. */
export function startHint(m: RoleModel) {
  const family = ['opus', 'sonnet', 'haiku', 'fable'].find((f) => m.model.includes(f));
  return {
    runtime: m.runtime,
    model: m.model,
    effort: m.effort,
    how:
      m.runtime === 'claude-code'
        ? `Claude Code: start the subagent with model "${family ?? m.model}" and effort "${m.effort}".`
        : m.runtime === 'codex'
          ? `Codex: start the agent with model "${m.model}" and reasoning effort "${m.effort}".`
          : `Start the agent with model ${m.model} and effort ${m.effort}.`,
  };
}
