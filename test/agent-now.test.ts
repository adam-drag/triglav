import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAgent } from '../src/agents.ts';
import { exec } from '../src/db.ts';
import { agentsNow, mapExtras } from '../src/telemetry.ts';
import { createTestCtx, TEST_DB_URL } from './helpers.ts';

const line = (o: object) => JSON.stringify(o) + '\n';
const tool = (at: string, name: string, input: object) => line({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: at, name, input }] } });

// Runs against a real MySQL: set ORCH_TEST_DATABASE_URL (see README). Skipped otherwise.
describe.skipIf(!TEST_DB_URL)('agentsNow', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let dir: string;
  let n = 0;

  beforeAll(async () => {
    env = await createTestCtx();
    dir = await mkdtemp(join(tmpdir(), 'agent-now-'));
  });
  afterAll(async () => {
    await env?.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** A Staff whose transcripts are these files, each written now and attributed to it in usage_daily. */
  async function staffWith(files: Record<string, string>) {
    const { agent_id } = await registerAgent(env.ctx, { role: 'staff', nickname: `staff-${++n}`, runtime: 'test' });
    const paths: Record<string, string> = {};
    for (const [name, text] of Object.entries(files)) {
      const path = join(dir, `${n}-${name}`);
      await writeFile(path, text);
      paths[name] = path;
      await exec(
        env.ctx.pool,
        `INSERT INTO usage_daily (source, agent_id, runtime, model, day, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, 'claude-code', 'm', '2026-11-19', 0, 0, 0, 0)`,
        [path, agent_id],
      );
    }
    return { id: agent_id as string, paths };
  }

  it('reads the transcript with the newest activity, not the newest file', async () => {
    // The old session stopped at 09:00 but keeps appending queue-operation lines, so its file is the newest.
    const { id, paths } = await staffWith({
      'old.jsonl': tool('2026-11-19T09:00:00Z', 'Read', { file_path: '/old.ts' }) + line({ type: 'queue-operation', timestamp: '2026-11-19T10:30:00Z' }),
      'new.jsonl': tool('2026-11-19T10:20:00Z', 'Edit', { file_path: '/new.ts' }),
    });
    await utimes(paths['old.jsonl'], new Date(), new Date(Date.now() + 60_000));
    const now = (await agentsNow(env.ctx, { claude: dir }))[id];
    expect(now.doing?.text).toBe('Editing new.ts');
    expect(now.at).toBe('2026-11-19T10:20:00Z');
  });

  it('counts a thinking block without text as activity', async () => {
    const { id } = await staffWith({
      'think.jsonl':
        tool('2026-11-19T10:00:00Z', 'Read', { file_path: '/a.ts' }) +
        line({ type: 'assistant', timestamp: '2026-11-19T10:25:00Z', message: { content: [{ type: 'thinking', thinking: '', signature: 's' }] } }),
    });
    expect((await agentsNow(env.ctx, { claude: dir }))[id].at).toBe('2026-11-19T10:25:00.000Z');
  });

  it('returns the newest progress note of each agent with an open session only', async () => {
    const open = (await registerAgent(env.ctx, { role: 'staff', nickname: `staff-${++n}`, runtime: 'test' })).agent_id as string;
    const ended = (await registerAgent(env.ctx, { role: 'staff', nickname: `staff-${++n}`, runtime: 'test' })).agent_id as string;
    const note = (actor: string, text: string, at: string) =>
      exec(env.ctx.pool, `INSERT INTO events (type, job_id, thread_id, actor, payload, created_at) VALUES ('progress', NULL, NULL, ?, ?, ?)`, [actor, JSON.stringify({ note: text, targets: [] }), new Date(at)]);
    await note(open, 'older note', '2026-11-19T10:00:00Z');
    await note(open, 'newest note', '2026-11-19T10:10:00Z');
    await note(ended, 'ended note', '2026-11-19T10:20:00Z');
    await exec(env.ctx.pool, `UPDATE agent_sessions SET ended_at = ? WHERE agent_id = ?`, [new Date('2026-11-19T10:30:00Z'), ended]);
    const { progress } = await mapExtras(env.ctx, { claude: dir });
    expect(progress[open]).toMatchObject({ note: 'newest note' });
    expect(new Date(progress[open].at).getTime()).toBe(Date.parse('2026-11-19T10:10:00Z'));
    expect(progress[ended]).toBeUndefined();
  });
});
