import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const BASE = process.env.ORCH_E2E_URL ?? 'http://localhost:7401';
export const KEY = process.env.ORCH_E2E_ENROLLMENT_KEY ?? 'e2e-enrollment-key-not-a-secret-000000';
export const RUNNER_KEY = process.env.ORCH_E2E_RUNNER_KEY ?? 'e2e-runner-key-not-a-secret-00000000';
/** The Client password of the throwaway stack (its hash is in docker-compose.e2e.yml). */
export const PASSWORD = process.env.ORCH_E2E_PASSWORD ?? 'e2e-dashboard-password-not-a-secret';

let sessionCookie: Promise<string> | undefined;
/** Logs in once and returns the session cookie, for tests that call the Client API directly. */
export function clientCookie(): Promise<string> {
  sessionCookie ??= fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) }).then((res) => {
    if (!res.ok) throw new Error(`e2e login failed: HTTP ${res.status}`);
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  });
  return sessionCookie;
}

/** fetch with the Client's session, like the dashboard sends it. */
export async function clientFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie: await clientCookie() } });
}

/** A scripted agent that uses the real MCP tools, the same way a CLI agent does. */
export class SimAgent {
  token = '';
  id = '';
  cursor = 0;
  assignment: { id: string; attempt: number; job_id: string } | null = null;
  lastControl: { action: string } | null = null;
  private readonly client: Client;
  private constructor(client: Client) {
    this.client = client;
  }

  static async connect(): Promise<SimAgent> {
    const client = new Client({ name: 'e2e-sim', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${KEY}` } } }));
    return new SimAgent(client);
  }

  static async register(args: { role: string; nickname: string; runtime?: string; focus?: string; spawn_ticket?: string }): Promise<SimAgent> {
    const agent = await SimAgent.connect();
    const reg = await agent.call('register_agent', { runtime: 'e2e', ...args }, false);
    agent.token = reg.session_token;
    agent.id = reg.agent_id;
    agent.cursor = reg.cursor;
    agent.assignment = reg.assignment;
    return agent;
  }

  async call(name: string, args: Record<string, unknown> = {}, withToken = true): Promise<any> {
    const res = (await this.client.callTool({ name, arguments: withToken ? { session_token: this.token, ...args } : args })) as { isError?: boolean; content: { text: string }[] };
    const body = JSON.parse(res.content[0]!.text);
    if (res.isError) throw new Error(`${name}: ${body.message}`);
    if (body.control) this.lastControl = body.control;
    return body.result;
  }

  async waitFor(type: string, maxWaitSec = 10): Promise<any> {
    const deadline = Date.now() + maxWaitSec * 1000;
    while (Date.now() < deadline) {
      const r = await this.call('wait_for_events', { cursor: this.cursor, max_wait_sec: 2 });
      this.cursor = r.next_cursor;
      const hit = r.events.find((e: any) => e.type === type);
      if (hit) return hit;
    }
    throw new Error(`${this.id} did not receive ${type} within ${maxWaitSec}s`);
  }

  async close() {
    await this.client.close().catch(() => {});
  }
}

/** A Staff agent with a freshly registered parent ticket and two subjobs, the first one ready. */
export async function staffWithJob(label: string) {
  const staff = await SimAgent.register({ role: 'staff', nickname: `staff-${label}` });
  const id = `E2E-${Date.now()}`;
  const node = (suffix: string, title: string) => ({ id: `uuid-${id}-${suffix}`, identifier: `${id}${suffix}`, title, description: `${title}. Created by the e2e suite.`, url: `https://linear.app/e2e/issue/${id}${suffix}` });
  const job = await staff.call('register_job', {
    linear_issue: id,
    repo_path: '/tmp/e2e-repo',
    base_branch: 'main',
    ticket_snapshot: { ...node('', `Export reports (${label})`), children: [node('-1', 'PDF endpoint'), node('-2', 'Export button')] },
  });
  const [a, b] = job.subjob_ids as string[];
  for (const jobId of [job.job_id, a, b]) {
    await staff.call('update_job', { job_id: jobId, status: 'planning' });
    await staff.call('update_job', { job_id: jobId, acceptance_criteria: 'Export works and has tests' });
  }
  await staff.call('update_job', { job_id: b, depends_on: [a] });
  await staff.call('update_job', { job_id: a, status: 'ready' });
  return { staff, identifier: id, parentId: job.job_id as string, a: a!, b: b! };
}

export async function spawnSenior(staff: SimAgent, jobId: string, nickname: string) {
  const t = await staff.call('create_spawn_ticket', { job_id: jobId, role: 'senior', brief: 'Implement it' });
  return SimAgent.register({ role: 'senior', nickname, spawn_ticket: t.spawn_ticket });
}
