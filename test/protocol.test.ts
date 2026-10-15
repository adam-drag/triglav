import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCtx } from '../src/context.ts';
import { createPool } from '../src/db.ts';
import { systemClock } from '../src/lib.ts';
import { buildServer } from '../src/server.ts';
import { TEST_ENROLLMENT_KEY, TEST_RUNNER_KEY, testPasswordHash } from './helpers.ts';

// No database needed: these tools and checks never touch MySQL. The pool connects lazily.
const KEY = TEST_ENROLLMENT_KEY;
const pool = createPool('mysql://nobody:nothing@127.0.0.1:1/none');
const ctx = createCtx({ pool, clock: systemClock, linear: null, baseUrl: 'http://localhost:7400' });
const app = buildServer(ctx, { enrollmentKey: KEY, runnerKey: TEST_RUNNER_KEY, passwordHash: await testPasswordHash(), webDir: '/nonexistent' });
let base = '';

beforeAll(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function connect(key = KEY) {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return client;
}

describe('MCP endpoint', () => {
  it('lists the orchestrator tools with explicit annotations', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['get_guide', 'register_agent', 'wait_for_events', 'ask_question', 'await_question', 'record_decision', 'create_spawn_ticket', 'get_review_comment']) expect(names).toContain(n);
    for (const t of tools) {
      expect(t.annotations, t.name).toBeDefined();
      if (!t.annotations!.readOnlyHint) expect(t.annotations!.destructiveHint, t.name).toBe(false);
    }
    await client.close();
  });

  it('serves the guide as a tool and over HTTP with the base URL filled in', async () => {
    const client = await connect();
    const res = (await client.callTool({ name: 'get_guide', arguments: {} })) as { content: { text: string }[] };
    const body = JSON.parse(res.content[0]!.text);
    expect(body.guide).toContain('## Staff Software Engineer');
    expect(body.guide).toContain('http://localhost:7400/mcp');
    expect(body.guide).not.toContain('{{BASE_URL}}');
    await client.close();
    const http = await fetch(`${base}/guide.md`);
    expect(http.status).toBe(200);
    expect(await http.text()).toContain('## Researcher');
    // With a role, only the common rules and that role's card.
    const senior = (await (await fetch(`${base}/guide.md?role=senior`)).text());
    expect(senior).toContain('## Senior Software Engineer');
    expect(senior).toContain('## Waiting for work');
    expect(senior).not.toContain('## Staff Software Engineer');
    expect(senior).not.toContain('## CLI setup');
    // The Copilot review loop is Triglav's own card, served to Seniors and in the whole guide, and needs no outside skill.
    expect(senior).toContain('## Delivery loop: Copilot review in at most 3 rounds');
    expect(senior).toContain('--add-reviewer "@copilot"');
    expect(senior).toContain('`review_mode`');
    expect(await (await fetch(`${base}/guide.md`)).text()).toContain('## Delivery loop: Copilot review in at most 3 rounds');
    expect(await (await fetch(`${base}/guide.md?role=staff`)).text()).not.toContain('## Delivery loop');
    expect(senior).not.toMatch(/plugins\/cache|SKILL_DIR|PushNotification|loop\.sh/);
  });

  it('refuses agent tools without a valid session token', async () => {
    const client = await connect();
    const res = (await client.callTool({ name: 'list_jobs', arguments: { session_token: 'nope' } })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).error).toBe('forbidden');
    await client.close();
  });

  it('rejects a wrong enrollment key', async () => {
    await expect(connect('wrong-key')).rejects.toThrow();
  });
});

describe('HTTP boundary', () => {
  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const port = Number(new URL(base).port);
    const status = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/api/health', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode!)).on('error', reject).end();
    });
    expect(status).toBe(403);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it('rejects cross-origin writes', async () => {
    const res = await fetch(`${base}/api/messages`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(403);
  });

  it('refuses non-JSON writes', async () => {
    const res = await fetch(`${base}/api/usage/claude`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'action=cancel' });
    expect(res.status).toBe(415);
  });
});
