import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseJson, queryOne } from '../src/db.ts';
import { getInitiative } from '../src/initiatives.ts';
import { createInitiative } from '../src/initiative-create.ts';
import { buildServer } from '../src/server.ts';
import { asClient, createTestCtx, loginCookie, TEST_DB_URL, testServerKeys } from './helpers.ts';

const KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The fields a refused body names: zod's issues carry them as `keys`. */
const refusedKeys = (message: string): string[] => JSON.parse(message).flatMap((issue: { keys?: string[] }) => issue.keys ?? []);

const body = (over: Record<string, unknown> = {}) => ({
  title: 'Start the billing rework',
  repos: [{ path: '/home/adam/workspace/app', base: 'main' }],
  prompt: 'Plan the billing rework. Keep the old invoices readable.',
  ...over,
});

/** Runs fn with ORCH_HOST_HOME set to value (or unset), then puts the variable back. */
async function withHome<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env.ORCH_HOST_HOME;
  if (value === undefined) delete process.env.ORCH_HOST_HOME;
  else process.env.ORCH_HOST_HOME = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.ORCH_HOST_HOME;
    else process.env.ORCH_HOST_HOME = before;
  }
}

/** The message of a refused call, or fails the test when the call succeeds. */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected the call to be refused');
}

// Runs against a real MySQL: set ORCH_TEST_DATABASE_URL (see README). Skipped otherwise.
describe.skipIf(!TEST_DB_URL)('createInitiative', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });

  it('makes a key that fits INITIATIVE_KEY for titles that stress it', async () => {
    const titles = ['Long '.repeat(60), '🚀 Launch', '../x', '!!!', 'Billing: Q4 / EU (v2)'];
    for (const title of titles) {
      const made = await withHome(undefined, () => createInitiative(env.ctx, body({ title })));
      expect(made.key, title).toMatch(KEY);
      expect(made.key.length, title).toBeLessThanOrEqual(63);
      expect(made.version).toBe(1);
      expect(made.chat_id).toMatch(/^cht_/);
    }
    expect((await withHome(undefined, () => createInitiative(env.ctx, body({ title: '🚀 Launch' })))).key).toMatch(/^launch-[0-9a-f]{6}$/);
    expect((await withHome(undefined, () => createInitiative(env.ctx, body({ title: '../x' })))).key).toMatch(/^x-[0-9a-f]{6}$/);
    expect((await withHome(undefined, () => createInitiative(env.ctx, body({ title: '!!!' })))).key).toMatch(/^initiative-[0-9a-f]{6}$/);
    const long = (await withHome(undefined, () => createInitiative(env.ctx, body({ title: 'Long '.repeat(60) })))).key;
    expect(long.length).toBe(63);
    expect(long).toMatch(/^long-long-[a-z-]*-[0-9a-f]{6}$/);
  });

  it('gives two initiatives with the same title and repository two rooms', async () => {
    const a = await withHome(undefined, () => createInitiative(env.ctx, body()));
    const b = await withHome(undefined, () => createInitiative(env.ctx, body()));
    expect(a.key).not.toBe(b.key);
    expect((await getInitiative(env.ctx, a.key)).initiative.key).toBe(a.key);
    expect((await getInitiative(env.ctx, b.key)).initiative.key).toBe(b.key);
  });

  it('lets two creations at the same moment both succeed', async () => {
    const made = await withHome(undefined, () => Promise.all([createInitiative(env.ctx, body()), createInitiative(env.ctx, body()), createInitiative(env.ctx, body())]));
    expect(new Set(made.map((m) => m.key)).size).toBe(3);
    for (const m of made) expect((await getInitiative(env.ctx, m.key)).initiative.key).toBe(m.key);
  });

  it('makes the Architect agent, its chat and version 1 with the prompt as one text block', async () => {
    const made = await withHome(undefined, () => createInitiative(env.ctx, body({ title: 'Architect check' })));
    const row = await queryOne(env.ctx.pool, 'SELECT id, architect_agent_id, chat_id, current_version FROM initiatives WHERE `key` = ?', [made.key]);
    expect(row).toMatchObject({ current_version: 1, chat_id: made.chat_id });
    expect(await queryOne(env.ctx.pool, 'SELECT role FROM agents WHERE id = ?', [row!.architect_agent_id])).toEqual({ role: 'architect' });
    expect(await queryOne(env.ctx.pool, "SELECT kind, initiative_id FROM chats WHERE id = ?", [made.chat_id])).toEqual({ kind: 'architect', initiative_id: row!.id });
    const version = await queryOne(env.ctx.pool, 'SELECT trigger_kind, trigger_ref, doc FROM initiative_versions WHERE initiative_id = ? AND version = 1', [row!.id]);
    expect(version).toMatchObject({ trigger_kind: 'create', trigger_ref: null });
    const doc = typeof version!.doc === 'string' ? JSON.parse(version!.doc) : version!.doc;
    expect(doc.blocks).toEqual([{ kind: 'text', id: 'T-brief', body: 'Plan the billing rework. Keep the old invoices readable.' }]);
  });

  it('names each repository by its folder, and makes repeats unique with -2 and -3', async () => {
    const made = await withHome(undefined, () =>
      createInitiative(
        env.ctx,
        body({
          repos: [
            { path: '/home/adam/Front End.app', base: 'main' },
            { path: '/home/adam/a/frontend', base: 'main' },
            { path: '/home/adam/b/frontend', base: 'main' },
            { path: '/home/adam/c/frontend', base: 'main', slug: 'web' },
          ],
        }),
      ),
    );
    const { initiative } = await getInitiative(env.ctx, made.key);
    expect(initiative.repos.map((r: { slug: string }) => r.slug)).toEqual(['front-end-app', 'frontend', 'frontend-2', 'web']);
  });

  it('refuses two repositories with one slug', async () => {
    const message = await withHome(undefined, () => refusal(createInitiative(env.ctx, body({ repos: [{ path: '/home/adam/a', base: 'main', slug: 'app' }, { path: '/home/adam/b', base: 'main', slug: 'app' }] }))));
    expect(message).toMatch(/same slug/);
  });

  it('keeps every path inside ORCH_HOST_HOME when it is set, and names the repository without echoing its path', async () => {
    const home = '/home/adam';
    const ok = await createInitiative(env.ctx, body({ repos: [{ path: '/home/adam/app', base: 'main' }] }), home);
    expect(ok.key).toMatch(KEY);
    const tilde = await createInitiative(env.ctx, body({ repos: [{ path: '~/tilde-app', base: 'main' }] }), home);
    const stored = await queryOne(env.ctx.pool, 'SELECT repos FROM initiatives WHERE `key` = ?', [tilde.key]);
    expect(parseJson<{ path: string }[]>(stored!.repos)[0]!.path).toBe('/home/adam/tilde-app');
    for (const path of ['/home/adam', '~', '/home/adam2/secret-folder', '/home/adam/../secret-folder', '/etc/x']) {
      const message = await refusal(createInitiative(env.ctx, body({ repos: [{ path, base: 'main' }] }), home));
      expect(message, path).toMatch(/^Repository 1: /);
      expect(message, path).not.toMatch(/secret-folder|\/etc|\/home\/adam/);
    }
    // A sibling folder with the same prefix and a home with a trailing slash.
    expect(await refusal(createInitiative(env.ctx, body({ repos: [{ path: '/home/adam2/app', base: 'main' }] }), home))).toMatch(/inside the home folder/);
    const slash = await createInitiative(env.ctx, body({ repos: [{ path: '/home/adam/slash-app', base: 'main' }] }), '/home/adam/');
    expect(slash.key).toMatch(KEY);
  });

  it('reads ORCH_HOST_HOME when no home is passed, and does not bound paths when it is unset', async () => {
    await withHome('/home/adam', async () => {
      expect(await refusal(createInitiative(env.ctx, body({ repos: [{ path: '/home/adam2/app', base: 'main' }] })))).toMatch(/inside the home folder/);
    });
    await withHome(undefined, async () => {
      const open = await createInitiative(env.ctx, body({ repos: [{ path: '/home/adam2/app', base: 'main' }] }));
      expect(open.key).toMatch(KEY);
      // Without ORCH_HOST_HOME checkRepoPath still refuses ~, because the server cannot know the home folder.
      expect(await refusal(createInitiative(env.ctx, body({ repos: [{ path: '~/app', base: 'main' }] })))).toMatch(/ORCH_HOST_HOME/);
    });
  });

  it('refuses a path that checkRepoPath refuses, with the repository named', async () => {
    const message = await withHome(undefined, () => refusal(createInitiative(env.ctx, body({ repos: [{ path: 'relative/app', base: 'main' }] }))));
    expect(message).toMatch(/^Repository 1: The repository path must be absolute/);
  });

  it('refuses a body with an extra field, naming it: key, doc and research_job_id', async () => {
    for (const extra of [{ key: 'mine' }, { doc: { format: 1 } }, { research_job_id: 'job_x' }]) {
      const field = Object.keys(extra)[0];
      expect(refusedKeys(await withHome(undefined, () => refusal(createInitiative(env.ctx, { ...body(), ...extra }))))).toEqual([field]);
    }
    const repoExtra = await withHome(undefined, () => refusal(createInitiative(env.ctx, body({ repos: [{ path: '/home/adam/a', base: 'main', github: 'x/y' }] }))));
    expect(refusedKeys(repoExtra)).toEqual(['github']);
  });

  it('refuses a title or a prompt that looks like a credential, without echoing it', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const inTitle = await withHome(undefined, () => refusal(createInitiative(env.ctx, body({ title: `Use ${token}` }))));
    expect(inTitle).toMatch(/credential/);
    expect(inTitle).not.toContain(token);
    const inPrompt = await withHome(undefined, () => refusal(createInitiative(env.ctx, body({ prompt: `Call the API with sk-ant-${'x'.repeat(30)}` }))));
    expect(inPrompt).toMatch(/credential/);
  });

  it('caps the title at 300 characters and the prompt at 20000, naming the field', async () => {
    expect(await withHome(undefined, () => refusal(createInitiative(env.ctx, body({ prompt: 'p'.repeat(20_001) }))))).toMatch(/prompt/);
    expect(await withHome(undefined, () => refusal(createInitiative(env.ctx, body({ title: 't'.repeat(301) }))))).toMatch(/title/);
    expect(await withHome(undefined, () => refusal(createInitiative(env.ctx, body({ title: '   ' }))))).toMatch(/title/);
  });
});

describe.skipIf(!TEST_DB_URL)('POST /api/initiatives/new', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });

  it('needs the Client session', async () => {
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    const res = await app.inject({ method: 'POST', url: '/api/initiatives/new', payload: body() });
    expect(res.statusCode).toBe(401);
  });

  it('creates the initiative and returns its key, version 1 and chat', async () => {
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    const cookie = await loginCookie(app);
    const res = await withHome(undefined, () => asClient(app, cookie).inject({ method: 'POST', url: '/api/initiatives/new', payload: body({ title: 'Route check' }) }));
    expect(res.statusCode).toBe(200);
    const made = res.json();
    expect(made).toEqual({ key: expect.stringMatching(/^route-check-[0-9a-f]{6}$/), version: 1, chat_id: expect.stringMatching(/^cht_/) });
    const room = await asClient(app, cookie).inject({ method: 'GET', url: `/api/initiatives/${made.key}` });
    expect(room.statusCode).toBe(200);
    expect(room.json().initiative.key).toBe(made.key);
  });

  it('refuses an extra field with a 400 that names it', async () => {
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    const cookie = await loginCookie(app);
    const res = await asClient(app, cookie).inject({ method: 'POST', url: '/api/initiatives/new', payload: { ...body(), research_job_id: 'job_x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/research_job_id/);
  });

  it('refuses a home path outside ORCH_HOST_HOME with a 400', async () => {
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    const cookie = await loginCookie(app);
    const res = await withHome('/home/adam', () =>
      asClient(app, cookie).inject({ method: 'POST', url: '/api/initiatives/new', payload: body({ repos: [{ path: '/home/adam2/app', base: 'main' }] }) }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/^Repository 1: The path must be inside the home folder/);
  });
});
