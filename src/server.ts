import { jobReviewsView, recordReviewOutput } from './code-review.ts';
import { resetReviewPanel, reviewPanelView, setReviewPanel } from './review-panel.ts';
import { closeRunOfLaunch, createPersona, researchOverview, updatePersona } from './research.ts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { editAgent } from './agent-edit.ts';
import { agentActivity, listAgents, openWorkFor, pokeAgent } from './agents.ts';
import { createSession, destroySession, LoginLimiter, MAX_PASSWORD_LENGTH, passwordLength, SESSION_SECONDS, sessionCookie, sessionValid, verifyPassword } from './client-auth.ts';
import { clientQueue, dismissBlocker, resolveBlocker } from './blockers.ts';
import { chatByToken, createChat, getChat, ingestChatEvents, issueChatToken, revokeChatToken, listChats, nextCommand, resetChatStates, sendChatMessage, stopChat, subscribe, MAX_CHAT_TEXT } from './chat.ts';
import { askQuestion, clientInbox, listBoard, markInboxSeen, postMessage, readThread, recordDecision, STANCES } from './board.ts';
import type { Ctx } from './context.ts';
import { query, queryOne } from './db.ts';
import { latestEventId, toEventRow } from './events.ts';
import { markDone } from './delivery.ts';
import { clientFinished, getJob, listJobs, markFinishedSeen, reassignStaff, reopenForDelivery, setControl } from './jobs.ts';
import { cancelJobRequest, createJobRequest, dismissJobRequest, listJobRequests, MAX_PATH, MAX_PROMPT, MAX_URL, retryJobRequest, replaceStaffForJob, startStaffForJob } from './job-requests.ts';
import { approveRefinement, clientRefine, MAX_REFINE_TEXT } from './refine.ts';
import { AppError, notFound } from './lib.ts';
import { buildMcpServer, GUIDE_ROLES, loadGuide } from './mcp.ts';
import { buildOperatorServer } from './operator.ts';
import { decideAction, expireHostActions, finishHostAction } from './operator-actions.ts';
import { detectedRuntimes, recordHostRuntimes, REVIEW_MODES, roleModelsView, setReviewMode, updateRoleModel } from './models.ts';
import { listArtifacts, mapExtras, usageReport, resumeList, requestResume, dismissResume, nextLaunch, finishLaunch, recentLaunches , planLimits, recordClaudeUsage} from './telemetry.ts';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };

function hostOf(header: string | undefined): string {
  if (!header) return '';
  return header.startsWith('[') ? header.slice(0, header.indexOf(']') + 1) : header.split(':')[0]!;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The /api/ routes that need no Client session. Everything else under /api/ is the Client's and needs the session cookie,
 * except /api/runner/*, which needs the runner key. Matched on the route pattern, never on the raw URL.
 * - health: the container health check.
 * - hooks/stop: the agents' Stop hook; it carries an agent session token.
 * - usage/claude: the Client's Claude status line posts plan usage without a key. A caller can only fake those numbers.
 * - login and logout: they make and end the session.
 */
const OPEN_API_ROUTES = new Set(['/api/health', '/api/hooks/stop', '/api/usage/claude', '/api/login', '/api/logout']);

/** What the built dashboard needs and nothing more: its own scripts, styles, images and API. */
export const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export function buildServer(ctx: Ctx, opts: { enrollmentKey: string; runnerKey: string; passwordHash: string; webDir: string; extraHosts?: string[]; streamCheckMs?: number }): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  const limiter = new LoginLimiter();
  const allowedHosts = new Set([...LOCAL_HOSTS, ...(opts.extraHosts ?? [])]);
  // Only JSON bodies: a cross-site form or text/plain post cannot reach a handler.
  app.removeContentTypeParser('text/plain');

  // DNS rebinding and cross-site protection: only local Host headers, and browser writes only from our own origin.
  app.addHook('onRequest', async (req, reply) => {
    if (!allowedHosts.has(hostOf(req.headers.host))) return reply.code(403).send({ error: 'forbidden', message: 'Unexpected Host header.' });
    const origin = req.headers.origin;
    if (origin && req.method !== 'GET') {
      let originHost = '';
      let originAuthority = '';
      try {
        const u = new URL(origin);
        originHost = u.hostname;
        originAuthority = u.host;
      } catch {}
      const bracketed = originHost.includes(':') ? `[${originHost}]` : originHost;
      // Same origin only: a page on another local port (http://localhost:<other>) has an allowed host name but is not us.
      if (!allowedHosts.has(bracketed) || originAuthority !== req.headers.host) return reply.code(403).send({ error: 'forbidden', message: 'Cross-origin request refused.' });
    }
  });

  // Who may call what. The runner key opens /api/runner/*, a Client session opens the rest of /api/ except the open list.
  // Every /api/ route needs the Client session by default. Add a route to OPEN_API_ROUTES only when it must work without a session, which is rare.
  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions?.url ?? '';
    if (!route.startsWith('/api/')) return;
    if (route.startsWith('/api/runner/')) {
      if (!safeEqual(String(req.headers.authorization ?? ''), `Bearer ${opts.runnerKey}`)) return reply.code(401).send({ error: 'unauthorized', message: 'Runner key required.' });
      return;
    }
    if (OPEN_API_ROUTES.has(route)) return;
    if (!(await sessionValid(ctx, opts.passwordHash, req.headers.cookie))) return reply.code(401).send({ error: 'unauthorized', message: 'Log in to use the dashboard.' });
  });

  // The dashboard has buttons that start Staff and approve criteria; do not let another page frame it.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AppError) return reply.code(error.status).send({ error: error.code, message: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid', message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: 'invalid', message: (error as Error).message });
    console.error(error);
    return reply.code(500).send({ error: 'internal', message: 'Internal error' });
  });

  // A stream is checked when it opens, so it also has to notice a logout or an expired session later: every tick it sends a
  // keep-alive, and ends the response when the session is gone or cannot be checked. `cleanup` runs once, on the close or on the end.
  const keepStreamAlive = (req: FastifyRequest, res: ServerResponse, cleanup: () => void) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      cleanup();
    };
    const timer = setInterval(() => {
      // A check that fails counts as an invalid session: the stream cannot show that it is still allowed.
      void sessionValid(ctx, opts.passwordHash, req.headers.cookie).then(
        (ok) => ok,
        () => false,
      ).then((ok) => {
        if (done) return;
        if (ok) res.write(': keep-alive\n\n');
        else {
          finish();
          res.end();
        }
      });
    }, opts.streamCheckMs ?? 15_000);
    req.raw.on('close', finish);
  };

  const mcp = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.headers.authorization ?? '';
    if (!safeEqual(auth, `Bearer ${opts.enrollmentKey}`)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'MCP requests need Authorization: Bearer <ORCH_ENROLLMENT_KEY>.' });
    }
    const server = buildMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.post('/mcp', mcp);
  app.get('/mcp', mcp);
  app.delete('/mcp', mcp);

  app.get('/guide.md', async (req, reply) => {
    const role = (req.query as { role?: string }).role;
    const known = GUIDE_ROLES.find((r) => r === role);
    return reply.type('text/markdown; charset=utf-8').send(loadGuide(ctx.baseUrl, known));
  });
  app.get('/api/health', async () => ({ ok: true }));

  // The Client's login. The password is checked against the scrypt hash from .env; a session is a random id in an HttpOnly cookie.
  app.post('/api/login', async (req, reply) => {
    const body = z
      .object({
        // The input is capped before it is normalized, so the check costs little. The shared maximum then counts what is hashed.
        password: z.string().min(1).max(MAX_PASSWORD_LENGTH * 10).refine((p) => passwordLength(p) <= MAX_PASSWORD_LENGTH, `The password can have at most ${MAX_PASSWORD_LENGTH} characters.`),
      })
      .parse(req.body);
    const attempt = limiter.take(ctx.clock.now());
    if (attempt.waitSec > 0) return reply.code(429).header('retry-after', String(attempt.waitSec)).send({ error: 'too_many_attempts', message: `Too many failed logins. Try again in ${attempt.waitSec} seconds.` });
    if (!(await verifyPassword(opts.passwordHash, body.password))) return reply.code(401).send({ error: 'unauthorized', message: 'Wrong password.' });
    attempt.refund();
    return reply.header('set-cookie', sessionCookie(await createSession(ctx, opts.passwordHash), SESSION_SECONDS)).send({ ok: true });
  });
  app.post('/api/logout', async (req, reply) => {
    await destroySession(ctx, opts.passwordHash, req.headers.cookie);
    return reply.header('set-cookie', sessionCookie('', 0)).send({ ok: true });
  });
  // The dashboard asks this once to decide between the login form and the app.
  app.get('/api/session', async () => ({ ok: true }));

  // Dashboard API. The Client is the only caller; the server binds to localhost.
  app.get('/api/jobs', async () => listJobs(ctx));
  app.get('/api/jobs/:id', async (req) => getJob(ctx.pool, (req.params as { id: string }).id));
  // Local review rounds and Copilot rounds of a job. A separate route: reviewer text is large and only the dashboard needs it.
  app.get('/api/jobs/:id/reviews', async (req) => {
    const id = (req.params as { id: string }).id;
    if (!(await queryOne(ctx.pool, `SELECT id FROM jobs WHERE id = ?`, [id]))) throw notFound(`Job ${id}`);
    return jobReviewsView(ctx.pool, id);
  });
  app.get('/api/threads/:id', async (req) => readThread(ctx, (req.params as { id: string }).id));
  app.get('/api/agents', async (req) => listAgents(ctx, { includeInactive: (req.query as { all?: string }).all === '1' }));
  app.post('/api/hooks/stop', async (req) => {
    const body = z.object({ session_token: z.string() }).parse(req.body);
    return { open_work: await openWorkFor(ctx, body.session_token) };
  });
  app.get('/api/agents/:id', async (req) => agentActivity(ctx, (req.params as { id: string }).id));
  app.post('/api/agents/:id/poke', async (req) => {
    const body = z.object({ note: z.string().max(8000).nullish() }).parse(req.body ?? {});
    return pokeAgent(ctx, (req.params as { id: string }).id, body.note ?? null);
  });
  app.put('/api/agents/:id', async (req) => {
    const body = z.object({ nickname: z.string().min(1).max(100).optional(), model: z.string().min(1).max(100).optional(), effort: z.string().min(1).max(20).optional() }).parse(req.body);
    return editAgent(ctx, (req.params as { id: string }).id, body);
  });
  app.get('/api/role-models', async () => roleModelsView(ctx));
  app.put('/api/review-mode', async (req) => setReviewMode(ctx, z.object({ mode: z.enum(REVIEW_MODES) }).parse(req.body).mode));
  // The local code review panel: the Client's setting, read by request_code_review when a review is requested.
  app.get('/api/review-panel', async () => reviewPanelView(ctx));
  app.put('/api/review-panel', async (req) => setReviewPanel(ctx, req.body));
  app.post('/api/review-panel/reset', async () => resetReviewPanel(ctx));
  app.get('/api/runtimes', async () => detectedRuntimes(ctx));
  app.put('/api/role-models/:role', async (req) => {
    const body = z.object({ runtime: z.string().min(1).max(40), model: z.string().min(1).max(100), effort: z.string().min(1).max(20) }).parse(req.body);
    return updateRoleModel(ctx, (req.params as { role: string }).role, body);
  });
  app.get('/api/usage', async () => ({ ...(await usageReport(ctx.pool)), limits: await planLimits(ctx.pool, ctx.clock.now()) }));
  // Claude Code's status line receives the plan usage; scripts/claude-statusline.sh forwards it here.
  const window = z.object({ used_percentage: z.number().min(0).max(100), resets_at: z.number().int().positive().optional() });
  app.post('/api/usage/claude', async (req) => {
    const body = z.object({ five_hour: window.optional(), seven_day: window.optional() }).parse(req.body);
    const now = ctx.clock.now();
    for (const [name, w] of Object.entries(body)) {
      if (w) await recordClaudeUsage(ctx.pool, { window: name, used: w.used_percentage, resetsAt: w.resets_at ? new Date(w.resets_at > 1e12 ? w.resets_at : w.resets_at * 1000) : null, at: now, source: 'statusline' });
    }
    return { ok: true };
  });
  app.get('/api/artifacts', async (req) => listArtifacts(ctx.pool, (req.query as { job_id?: string }).job_id));
  app.get('/api/feed', async () => feed(ctx));
  app.get('/api/map', async () => mapExtras(ctx));
  app.get('/api/queue', async () => clientQueue(ctx));
  app.get('/api/inbox', async (req) => clientInbox(ctx, (req.query as { read?: string }).read === '1'));
  app.post('/api/inbox/seen', async (req) => markInboxSeen(ctx, z.object({ ids: z.array(z.number().int()).optional() }).parse(req.body ?? {}).ids));
  app.get('/api/finished', async () => clientFinished(ctx));
  app.post('/api/finished/seen', async (req) => markFinishedSeen(ctx, z.object({ ids: z.array(z.string().max(40)).max(100).optional() }).parse(req.body ?? {}).ids));
  app.get('/api/resume', async () => ({ agents: await resumeList(ctx), launches: await recentLaunches(ctx) }));
  app.post('/api/agents/:id/resume', async (req) => requestResume(ctx, (req.params as { id: string }).id));
  app.post('/api/agents/:id/dismiss-resume', async (req) => dismissResume(ctx, (req.params as { id: string }).id));
  // The host runner authenticates with ORCH_RUNNER_KEY (checked in the onRequest hook above, for every /api/runner/ route).
  // It is not the enrollment key that agents hold: the runner is the only caller that starts processes on the machine.
  app.post('/api/runner/next', async (req) => {
    return { launch: await nextLaunch(ctx) };
  });
  // The runner reports which agent CLIs it found on the machine: a version, or null when one is missing.
  app.post('/api/runner/runtimes', async (req) => {
    // A model id ends up in commands the runner builds, so it must be a plain identifier.
    const model = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/), label: z.string().max(100), efforts: z.array(z.string().regex(/^[a-z]{1,20}$/)).min(1).max(10) });
    const cli = z.object({ version: z.string().max(100), models: z.array(model).max(60) }).nullable();
    const body = z.object({ 'claude-code': cli, codex: cli }).parse(req.body);
    await recordHostRuntimes(ctx, body);
    return { ok: true };
  });
  app.post('/api/runner/:id/done', async (req) => {
    const body = z.object({ result: z.string().max(4000) }).parse(req.body);
    const id = (req.params as { id: string }).id;
    await finishLaunch(ctx, id, body.result);
    // A research run that did not start has no process that will exit, so its run is closed here and its items go back to the inbox.
    if (body.result.startsWith('failed:')) await closeRunOfLaunch(ctx, id, 'failed', body.result);
    return { ok: true };
  });
  // The runner reports when a research run's process exits; a run that never called end_run is closed and its items return to the inbox.
  app.post('/api/runner/:id/exited', async (req) => {
    const body = z.object({ code: z.number().int().nullable(), tail: z.string().max(4000) }).parse(req.body);
    await closeRunOfLaunch(ctx, (req.params as { id: string }).id, body.code === 0 ? 'ended' : 'failed', `exit ${body.code}\n${body.tail}`);
    return { ok: true };
  });
  // A code reviewer's process ended: the runner posts what it printed. It is untrusted model output; src/code-review.ts
  // parses it and never executes or follows it. stdout is capped by the runner and here (Fastify's body limit is 1 MB).
  app.post('/api/runner/:id/review-output', async (req) => {
    const body = z.object({ code: z.number().int().nullable(), stdout: z.string().max(600_000), stderr: z.string().max(8000), secs: z.number().min(0).max(1e6) }).parse(req.body);
    await recordReviewOutput(ctx, (req.params as { id: string }).id, body);
    return { ok: true };
  });
  // The Operator: a Claude Code chat the Client has in the dashboard. The runner owns the process; see src/chat.ts.
  const chatText = z.object({ text: z.string().max(MAX_CHAT_TEXT * 2) });
  app.get('/api/chats', async () => listChats(ctx));
  app.post('/api/chats', async (req) => createChat(ctx, chatText.parse(req.body)));
  app.get('/api/chats/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    await expireHostActions(ctx, id);
    return getChat(ctx, id);
  });
  // The Client's click on a request card: confirm runs it, deny drops it.
  app.post('/api/chats/:id/actions/:actionId', async (req) => {
    const p = req.params as { id: string; actionId: string };
    return decideAction(ctx, p.id, p.actionId, z.object({ decision: z.enum(['confirm', 'deny']) }).parse(req.body).decision);
  });
  app.post('/api/chats/:id/messages', async (req) => sendChatMessage(ctx, (req.params as { id: string }).id, chatText.parse(req.body)));
  app.post('/api/chats/:id/stop', async (req) => stopChat(ctx, (req.params as { id: string }).id));
  app.get('/api/chats/:id/stream', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    await getChat(ctx, id);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    const sub = subscribe(id, send);
    send({ type: 'hello', partial: sub.partial });
    keepStreamAlive(req, res, () => sub.unsubscribe());
  });
  // The runner takes the Client's messages one at a time and reports what its Claude process says.
  app.post('/api/runner/chat/hello', async (req) => {
    await resetChatStates(ctx);
    return { ok: true };
  });
  app.post('/api/runner/chat/next', async (req, reply) => {
    // A runner that hangs up (it was restarted) must not take a message that nobody will receive.
    const gone = new AbortController();
    reply.raw.on('close', () => gone.abort());
    return { command: await nextCommand(ctx, 20_000, gone.signal) };
  });
  // A fresh token for the process the runner is about to start for this chat. Only its hash is stored; this response is the one time the plain value leaves the server.
  app.post('/api/runner/chat/:id/token', async (req) => ({ token: await issueChatToken(ctx, (req.params as { id: string }).id) }));
  // The process that held the token has ended. Only a token that is still the current one is cleared.
  app.post('/api/runner/chat/:id/token/revoke', async (req) => {
    await revokeChatToken(ctx, (req.params as { id: string }).id, z.object({ token: z.string().min(1).max(200) }).parse(req.body).token);
    return { ok: true };
  });
  app.post('/api/runner/chat/:id/events', async (req) => {
    const body = z
      .object({
        events: z
          .array(
            z.discriminatedUnion('type', [
              z.object({ type: z.literal('session'), session_id: z.string().max(40) }),
              z.object({ type: z.literal('delta'), text: z.string().max(20_000) }),
              z.object({ type: z.literal('message'), role: z.enum(['operator', 'tool', 'system']), text: z.string().max(100_000) }),
              z.object({ type: z.literal('state'), state: z.enum(['idle', 'working', 'stopped']) }),
              z.object({ type: z.literal('usage'), windows: z.array(z.object({ window: z.string().max(20), used: z.number(), resets_at: z.number().nullable() })).max(4) }),
              z.object({ type: z.literal('action_result'), action_id: z.string().max(40), ok: z.boolean(), text: z.string().max(2000) }),
            ]),
          )
          .max(200),
      })
      .parse(req.body);
    const chatId = (req.params as { id: string }).id;
    await ingestChatEvents(ctx, chatId, body.events.filter((e) => e.type !== 'action_result') as Parameters<typeof ingestChatEvents>[2]);
    for (const e of body.events) if (e.type === 'action_result') await finishHostAction(ctx, e.action_id, e.ok, e.text);
    return { ok: true };
  });
  // The Operator's own tools. The token belongs to one chat, so only that chat's process can call them.
  const operatorMcp = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const chat = token ? await chatByToken(ctx, token) : undefined;
    if (!chat) return reply.code(401).send({ error: 'unauthorized', message: 'The Operator tools need the token of a chat.' });
    const server = buildOperatorServer(ctx, chat.id as string);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.post('/operator/mcp', operatorMcp);
  app.get('/operator/mcp', operatorMcp);
  app.delete('/operator/mcp', operatorMcp);
  // Start a job from the dashboard. The server checks the shape of every field; the runner checks the directory exists.
  const jobRequestBody = z.object({
    mode: z.enum(['link', 'prompt']),
    url: z.string().max(MAX_URL + 100).nullish(),
    prompt: z.string().max(MAX_PROMPT + 1000).nullish(),
    repo_path: z.string().max(MAX_PATH + 100),
    base_branch: z.string().max(300).nullish(),
  });
  app.get('/api/job-requests', async () => listJobRequests(ctx));
  app.post('/api/job-requests', async (req) => {
    const b = jobRequestBody.parse(req.body);
    return createJobRequest(ctx, { mode: b.mode, url: b.url, prompt: b.prompt, repoPath: b.repo_path, baseBranch: b.base_branch });
  });
  app.post('/api/job-requests/:id/retry', async (req) => retryJobRequest(ctx, (req.params as { id: string }).id));
  app.post('/api/job-requests/:id/dismiss', async (req) => dismissJobRequest(ctx, (req.params as { id: string }).id));
  app.post('/api/job-requests/:id/cancel', async (req) => cancelJobRequest(ctx, (req.params as { id: string }).id));
  app.get('/api/research', async () => researchOverview(ctx));
  const personaBody = z.object({ nickname: z.string().min(1).max(100), focus: z.string().min(1).max(500), repo_path: z.string().min(1).max(500), model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']) });
  app.post('/api/research/personas', async (req) => createPersona(ctx, personaBody.parse(req.body)));
  app.put('/api/research/personas/:id', async (req) => updatePersona(ctx, (req.params as { id: string }).id, personaBody.partial().omit({ nickname: true }).extend({ enabled: z.boolean().optional() }).parse(req.body)));
  app.get('/api/board', async (req) => listBoard(ctx.pool, { jobId: (req.query as { job_id?: string }).job_id, limit: 100 }));
  app.get('/api/events', async (req) => {
    const q = req.query as { job_id?: string; limit?: string };
    const rows = await query(
      ctx.pool,
      `SELECT * FROM events ${q.job_id ? 'WHERE job_id = ? OR job_id IN (SELECT id FROM jobs WHERE parent_job_id = ?)' : ''} ORDER BY id DESC LIMIT ${Math.min(Number(q.limit ?? 100) || 100, 500)}`,
      q.job_id ? [q.job_id, q.job_id] : [],
    );
    return rows.map(toEventRow);
  });

  const controlBody = z.object({ action: z.enum(['pause', 'resume', 'cancel']), reason: z.string().nullish() });
  app.post('/api/jobs/:id/control', async (req) => {
    const body = controlBody.parse(req.body);
    return setControl(ctx, (req.params as { id: string }).id, body.action, body.reason ?? null);
  });
  // Refinement of a job that started from a prompt: the Client answers or edits, and only the Client approves.
  // Approve may carry a last answer or edits, which Staff reads while planning instead of refining again.
  const refineBody = z.object({ message: z.string().max(MAX_REFINE_TEXT + 100).optional(), plan: z.string().max(MAX_REFINE_TEXT + 100).optional(), acceptance_criteria: z.string().max(MAX_REFINE_TEXT + 100).optional() });
  app.post('/api/jobs/:id/refine', async (req) => {
    const b = refineBody.parse(req.body);
    return clientRefine(ctx, (req.params as { id: string }).id, { message: b.message, plan: b.plan, acceptanceCriteria: b.acceptance_criteria });
  });
  app.post('/api/jobs/:id/approve', async (req) => {
    const b = refineBody.parse(req.body ?? {});
    return approveRefinement(ctx, (req.params as { id: string }).id, { message: b.message, plan: b.plan, acceptanceCriteria: b.acceptance_criteria });
  });
  app.post('/api/jobs/:id/reopen', async (req) => {
    const body = z.object({ reason: z.string().min(1) }).parse(req.body);
    return reopenForDelivery(ctx, (req.params as { id: string }).id, body.reason);
  });
  app.post('/api/jobs/:id/mark-done', async (req) => {
    const body = z.object({ reason: z.string().min(1) }).parse(req.body);
    return markDone(ctx, (req.params as { id: string }).id, body.reason);
  });
  app.post('/api/jobs/:id/new-staff', async (req) => startStaffForJob(ctx, (req.params as { id: string }).id));
  app.post('/api/jobs/:id/replace-staff', async (req) => replaceStaffForJob(ctx, (req.params as { id: string }).id));
  app.post('/api/jobs/:id/staff', async (req) => {
    const body = z.object({ staff_agent_id: z.string() }).parse(req.body);
    return reassignStaff(ctx, (req.params as { id: string }).id, body.staff_agent_id);
  });

  const messageBody = z.object({
    job_id: z.string().optional(),
    thread_id: z.string().optional(),
    type: z.enum(['discussion', 'reply', 'proposal']).default('discussion'),
    stance: z.enum(STANCES).default('inform'),
    reason: z.string().optional(),
    body: z.string().min(1),
    in_reply_to: z.number().int().optional(),
    mentions: z.array(z.string()).optional(),
    request_id: z.string().optional(),
  });
  app.post('/api/messages', async (req) => {
    const b = messageBody.parse(req.body);
    return postMessage(ctx, { kind: 'client' }, { jobId: b.job_id, threadId: b.thread_id, type: b.type, stance: b.stance, reason: b.reason, body: b.body, inReplyTo: b.in_reply_to, mentions: b.mentions, requestId: b.request_id });
  });

  const questionBody = z.object({
    job_id: z.string(),
    title: z.string().min(1),
    summary: z.string().optional(),
    question: z.string().min(1),
    why_it_matters: z.string().optional(),
    waiting_work: z.string().optional(),
    options: z.string().optional(),
    window_sec: z.number().int().optional(),
    requires_staff_decision: z.boolean().default(false),
    request_id: z.string().optional(),
  });
  app.post('/api/questions', async (req) => {
    const b = questionBody.parse(req.body);
    return askQuestion(ctx, { kind: 'client' }, { jobId: b.job_id, title: b.title, summary: b.summary, question: b.question, whyItMatters: b.why_it_matters, waitingWork: b.waiting_work, options: b.options, windowSec: b.window_sec, requiresStaffDecision: b.requires_staff_decision, requestId: b.request_id });
  });

  const decisionBody = z.object({ thread_id: z.string(), body: z.string().min(1), rationale: z.string().min(1), considered_message_ids: z.array(z.number().int()).default([]), supersedes_decision_id: z.string().optional() });
  app.post('/api/decisions', async (req) => {
    const b = decisionBody.parse(req.body);
    return recordDecision(ctx, { kind: 'client' }, { threadId: b.thread_id, body: b.body, rationale: b.rationale, consideredMessageIds: b.considered_message_ids, supersedesDecisionId: b.supersedes_decision_id });
  });

  app.post('/api/blockers/:id/resolve', async (req) => {
    const b = z.object({ resolution: z.string().min(1) }).parse(req.body);
    return resolveBlocker(ctx, { kind: 'client' }, { blockerId: (req.params as { id: string }).id, resolution: b.resolution });
  });

  app.post('/api/blockers/:id/dismiss', async (req) => {
    const b = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {});
    return dismissBlocker(ctx, (req.params as { id: string }).id, b.note);
  });

  // Server-sent events: tells the dashboard what changed. The database stays the record.
  app.get('/api/stream', async (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let cursor = Number(req.headers['last-event-id'] ?? 0) || (await latestEventId(ctx.pool));
    let busy = false;
    const push = async () => {
      if (busy) return;
      busy = true;
      try {
        const rows = await query(ctx.pool, `SELECT id, type, job_id, thread_id FROM events WHERE id > ? ORDER BY id LIMIT 500`, [cursor]);
        for (const r of rows) {
          cursor = Number(r.id);
          res.write(`id: ${cursor}\ndata: ${JSON.stringify({ id: cursor, type: r.type, job_id: r.job_id, thread_id: r.thread_id })}\n\n`);
        }
      } catch (error) {
        console.error('sse push failed', error);
      } finally {
        busy = false;
      }
    };
    const onChange = () => void push();
    ctx.bus.on('change', onChange);
    res.write('retry: 2000\n\n');
    keepStreamAlive(req, res, () => ctx.bus.off('change', onChange));
  });

  // Static dashboard. Unknown paths fall back to index.html for client-side routing.
  app.get('/*', async (req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', message: 'Unknown API path' });
    const index = join(opts.webDir, 'index.html');
    if (!existsSync(index)) return reply.type('text/plain').send('Dashboard not built. Run: pnpm build:web');
    const rel = normalize(decodeURIComponent((req.params as { '*': string })['*'] || 'index.html')).replace(/^(\.\.[/\\])+/, '');
    const file = join(opts.webDir, rel);
    const target = file.startsWith(opts.webDir) && existsSync(file) && statSync(file).isFile() ? file : index;
    return reply.type(MIME[extname(target)] ?? 'application/octet-stream').send(readFileSync(target));
  });

  return app;
}

const FEED_TYPES = ['refinement.staff_posted', 'refinement.proposal_updated', 'refinement.approved', 'job_request.created', 'job_request.cancelled', 'artifact.recorded', 'review.submitted', 'review.verdict', 'delivery.reported', 'delivery.confirmed', 'job.status', 'message.posted', 'question.opened', 'decision.recorded', 'blocker.raised'];

/** Short one-line notices for the Client: who did what on which job, with a link. No details. */
async function feed(ctx: Ctx) {
  const rows = await query(
    ctx.pool,
    `SELECT e.id, e.type, e.job_id, e.thread_id, e.actor, e.payload, e.created_at, a.nickname, a.role, j.linear_identifier
     FROM events e LEFT JOIN agents a ON a.id = e.actor LEFT JOIN jobs j ON j.id = e.job_id
     WHERE e.type IN (?) ORDER BY e.id DESC LIMIT 300`,
    [FEED_TYPES],
  );
  const items = [];
  for (const r of rows) {
    const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload ?? {});
    const who = r.actor === 'client' ? 'Client' : r.actor === 'scheduler' ? 'Scheduler' : r.nickname ? `${r.nickname} (${r.role})` : r.actor;
    const job = r.linear_identifier ?? 'a job';
    const jobLink = r.job_id ? `#/jobs/${r.job_id}` : null;
    let text: string | null = null;
    let link = jobLink;
    switch (r.type) {
      case 'artifact.recorded':
        text = `${who} ${p.kind === 'pr' ? 'opened or updated PR' : p.kind === 'branch' ? 'created branch' : 'pushed'} ${p.label} on ${job}`;
        link = p.url;
        break;
      case 'review.submitted':
        text = `${who} finished work on ${job} (review round ${p.round})`;
        break;
      case 'review.verdict':
        text = `${who} reviewed ${job}: ${p.outcome}`;
        break;
      case 'delivery.reported':
        text = `${who} reported delivery on ${job}`;
        break;
      case 'delivery.confirmed':
        text = `${who} confirmed delivery on ${job}`;
        break;
      case 'job.status':
        if (p.to === 'done') text = `${job} is done`;
        else if (p.to === 'blocked') text = `${job} is blocked`;
        break;
      case 'message.posted':
        if (r.role === 'researcher') text = `${who} commented on ${job}`;
        link = r.thread_id ? `#/threads/${r.thread_id}` : jobLink;
        break;
      case 'question.opened':
        text = `${who} asked a question on ${job}`;
        link = r.thread_id ? `#/threads/${r.thread_id}` : jobLink;
        break;
      case 'decision.recorded':
        text = `${who} recorded a decision on ${job}`;
        link = r.thread_id ? `#/threads/${r.thread_id}` : jobLink;
        break;
      case 'refinement.staff_posted':
        text = `${who} wrote on ${job} while refining it`;
        link = r.thread_id ? `#/threads/${r.thread_id}` : jobLink;
        break;
      case 'refinement.proposal_updated':
        text = `${who} updated the proposal for ${job}`;
        break;
      case 'refinement.approved':
        text = `Client approved the criteria for ${job}`;
        break;
      case 'job_request.created':
        if (p.mode === 'takeover') {
          text = `Client asked for a new Staff to take over ${job}`;
          link = jobLink;
          break;
        }
        text = `Client asked to start a ${p.mode === 'link' ? 'job from a ticket link' : 'job from a prompt'}`;
        link = '#/new';
        break;
      case 'job_request.cancelled':
        text = 'Client cancelled a job request before it started';
        link = '#/new';
        break;
      case 'blocker.raised':
        text = `${who} raised a ${String(p.kind ?? 'blocker').replaceAll('_', ' ')} blocker on ${job}`;
        link = '#/queue';
        break;
    }
    if (text) items.push({ id: Number(r.id), type: r.type, at: r.created_at, text, link, job_id: r.job_id });
    if (items.length >= 150) break;
  }
  return items;
}
