import { tx, type Ctx } from './context.ts';
import { exec, queryOne } from './db.ts';
import { emit } from './events.ts';
import { conflict, invalid, notFound } from './lib.ts';
import { checkAgainstCatalog, detectedRuntimes, SAFE } from './models.ts';
import { requestSwitch } from './telemetry.ts';

export type AgentEdit = { nickname?: string; model?: string; effort?: string };

/**
 * The Client edits an agent: its name, and the model and effort it runs on. The runtime (Claude Code or Codex) never
 * changes: the model is checked against what that CLI offers on this machine.
 * - A name changes at once. The agent still knows its old one until it registers again.
 * - A researcher persona keeps its model and effort in its own row and uses them from its next run.
 * - A running Claude Code Staff is restarted with the new values (see requestSwitch). Seniors and reviewers are
 *   Staff's subagents, started with the role's model, so they cannot be switched from here.
 */
export async function editAgent(ctx: Ctx, agentId: string, input: AgentEdit) {
  const nickname = input.nickname?.trim();
  if (input.nickname !== undefined && !nickname) throw invalid('The name cannot be empty.');
  if (nickname && nickname.length > 100) throw invalid('The name is at most 100 characters.');
  for (const [field, value] of [['model', input.model], ['effort', input.effort]] as const) {
    if (value !== undefined && !SAFE.test(value)) throw invalid(`${field} may only contain letters, digits, ".", "_", ":" and "-", and must start with a letter or digit.`);
  }
  const wantsModel = input.model !== undefined || input.effort !== undefined;
  if (nickname === undefined && !wantsModel) throw invalid('Nothing to change.');

  const a = await queryOne(ctx.pool, `SELECT id, nickname, role, runtime, model, effort FROM agents WHERE id = ?`, [agentId]);
  if (!a) throw notFound(`Agent ${agentId}`);
  const persona = a.role === 'researcher' ? await queryOne(ctx.pool, `SELECT id, model, effort FROM researcher_personas WHERE agent_id = ?`, [agentId]) : null;
  const model = input.model ?? (persona?.model as string | undefined) ?? (a.model as string | null);
  const effort = input.effort ?? (persona?.effort as string | undefined) ?? (a.effort as string | null);
  const modelChanges = wantsModel && (model !== (persona?.model ?? a.model) || effort !== (persona?.effort ?? a.effort));

  if (modelChanges) {
    if (!model || !effort) throw invalid('Give both a model and an effort: this agent has no saved value for one of them.');
    if (a.role !== 'staff' && !persona) throw conflict(`A ${a.role} is started by Staff with the ${a.role} role's model, so its model cannot be switched. Change the role's model on the Models page.`);
    if (a.runtime !== 'claude-code' && !persona) throw conflict(`Only a Claude Code Staff can be restarted with another model. This one runs on ${a.runtime}.`);
    checkAgainstCatalog(await detectedRuntimes(ctx), { runtime: a.runtime as string, model, effort });
  }

  let switchQueued = false;
  await tx(ctx, async (conn) => {
    if (nickname !== undefined && nickname !== a.nickname) {
      await exec(conn, `UPDATE agents SET nickname = ? WHERE id = ?`, [nickname, agentId]);
      if (persona) await exec(conn, `UPDATE researcher_personas SET nickname = ? WHERE agent_id = ?`, [nickname, agentId]);
      await emit(conn, ctx, { type: 'agent.renamed', actor: 'client', targets: [agentId], payload: { from: a.nickname, to: nickname } });
    }
    if (modelChanges && persona) {
      await exec(conn, `UPDATE researcher_personas SET model = ?, effort = ? WHERE id = ?`, [model, effort, persona.id]);
      await exec(conn, `UPDATE agents SET model = ?, effort = ? WHERE id = ?`, [model, effort, agentId]);
    }
  });
  // The launch is its own write: the agent row only changes when the runner reports the restart done.
  if (modelChanges && !persona) {
    await requestSwitch(ctx, agentId, model!, effort!);
    switchQueued = true;
  }
  return { ok: true, switch_queued: switchQueued };
}
