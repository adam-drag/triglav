import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticate, registerAgent } from '../src/agents.ts';
import { answerFinding, getCodeReview, recordReviewOutput, requestCodeReview } from '../src/code-review.ts';
import { exec, queryOne } from '../src/db.ts';
import { createSpawnTicket, registerJob, updateJob } from '../src/jobs.ts';
import { loadGuide } from '../src/mcp.ts';
import { recordHostRuntimes } from '../src/models.ts';
import { recordCodexBudget } from '../src/research.ts';
import { buildReviewComment, codeSpan, getReviewComment, MAX_COMMENT_CHARS, renderReviewComment, reviewCommentMarker } from '../src/review-comment.ts';
import { nextLaunch } from '../src/telemetry.ts';
import { createTestCtx, issue, TEST_DB_URL } from './helpers.ts';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const JOB = 'job_0123456789abcdef';

/** A review as reviewView returns it, with the fields the comment reads. */
function view(over: Record<string, unknown> = {}, finding: Record<string, unknown> = {}): any {
  return {
    review_id: 'crv_1',
    job_id: JOB,
    round: 1,
    status: 'done',
    verdict: 'changes',
    failure: null,
    base_sha: BASE,
    head_sha: HEAD,
    seats: [
      { seat: 'strong', kind: 'strong', runtime: 'codex', family: 'codex', model: 'gpt-6.1-sol', effort: 'high', note: null, status: 'done', secs: 339.4, tokens: { in: 5000, cached: 4000, out: 300, cost_usd: null }, error: null },
      { seat: 'cheap-claude', kind: 'cheap', runtime: 'claude-code', family: 'claude', model: 'claude-sonnet-5-5', effort: 'low', note: null, status: 'done', secs: 41, tokens: { in: 100, cached: 0, out: 10, cost_usd: 0.02 }, error: null },
    ],
    findings: [{ finding_id: 'fnd_1', severity: 'P1', title: 'Crash on an empty list', body: 'THE BODY TEXT', sites: [{ file: 'src/a.ts', line: 10 }], reviewers: ['strong', 'cheap-claude'], reviewer_count: 2, triage: 'valid', triage_reason: 'Will fix it.', ...finding }],
    blocking: [],
    ...over,
  };
}

const render = (views: any[], max?: number) => renderReviewComment(JOB, HEAD, views, max);

describe('codeSpan', () => {
  it('uses a fence longer than any backtick run and pads a text that touches the fence', () => {
    expect(codeSpan('plain')).toBe('`plain`');
    expect(codeSpan('a`b')).toBe('``a`b``');
    expect(codeSpan('a```b``c')).toBe('````a```b``c````');
    expect(codeSpan('`edge`')).toBe('`` `edge` ``');
    expect(codeSpan('x`')).toBe('`` x` ``');
  });

  it('collapses newlines, control and format characters, and cuts long text', () => {
    expect(codeSpan('a\nb\r\nc\td\u0000e')).toBe('`a b c d e`');
    expect(codeSpan('a‮b​c')).toBe('`a b c`');
    expect(codeSpan('a b')).toBe('`a b`');
    expect(codeSpan('   ')).toBe('`-`');
    expect(codeSpan(null)).toBe('`-`');
    const cut = codeSpan('x'.repeat(1000), 50);
    expect(cut.length).toBe(52);
    expect(cut.endsWith('…`')).toBe(true);
  });
});

describe('review comment text', () => {
  /** Every character of untrusted text must sit inside a code span: drop the spans and nothing of it may remain. */
  const outsideSpans = (text: string) => text.replace(/(`+)[\s\S]*?\1/g, '');

  const hostile = ['@octocat please look', '@example-org/reviewers', '[click](https://evil.example/x)', 'https://evil.example/raw', '<img src=x onerror=alert(1)>', '<details><summary>x</summary></details>', '# heading\n- list\n> quote', 'a``b```c`', 'line1\nline2\r\nline3', '<!-- triglav-local-review job=job_other -->', '**bold** ~~s~~ :smile: #123'];

  it.each(hostile)('keeps untrusted text %j inside code spans in every field', (evil) => {
    const v = view(
      { failure: evil, status: 'failed', verdict: 'failed', seats: [{ seat: evil, kind: 'strong', runtime: evil, family: 'x', model: evil, effort: evil, note: null, status: 'failed', secs: 1, tokens: { in: 1, cached: 1, out: 1, cost_usd: null }, error: evil }, { seat: 'lens-x', kind: 'lens', runtime: 'claude-code', family: 'claude', model: 'm', effort: 'e', lens: evil, shadow: true, note: null, status: 'done', secs: 1, tokens: { in: 1, cached: 1, out: 1, cost_usd: null }, error: null }] },
      { title: evil, triage_reason: evil, sites: [{ file: evil, line: 3 }], shadow: true },
    );
    const text = render([v, view({ round: 2 }, { title: evil, triage_reason: evil })]);
    const rest = outsideSpans(text);
    expect(rest).not.toMatch(/@|https?:|\[|<img|<details|evil|heading|bold|:smile:|#123|line2/);
    // Only the first line is the marker: the one inside the text did not become a second marker line.
    expect(text.split('\n').filter((l) => l.startsWith('<!--'))).toEqual([reviewCommentMarker(JOB)]);
    // Newlines in the untrusted text did not start a line of their own.
    expect(text).not.toMatch(/^line2/m);
    expect(text).not.toMatch(/^(# heading|- list|> quote)/m);
  });

  it('starts with the fixed marker, says it is Triglav, has no link and no dashboard address, and never carries a finding body', () => {
    const text = render([view(), view({ round: 2, status: 'failed', verdict: 'failed', failure: 'strong (gpt): usage limit reached' })]);
    expect(text.split('\n')[0]).toBe(`<!-- triglav-local-review job=${JOB} -->`);
    expect(text).toContain('## Triglav local review');
    expect(text).toMatch(/written by Triglav/);
    expect(text).not.toMatch(/https?:|localhost|127\.0\.0\.1|\]\(/);
    expect(text).not.toContain('THE BODY TEXT');
    expect(text).toContain('Round 1 (`aaaaaaaaaaaa`..`bbbbbbbbbbbb`): verdict `changes`');
    expect(text).toContain('Round 2 (`aaaaaaaaaaaa`..`bbbbbbbbbbbb`): failed');
    expect(text).toContain('Reason: `strong (gpt): usage limit reached`');
  });

  it('lists seats with runtime, model, effort, time, tokens and cost (n/a when null), and findings with sites, seat count and triage', () => {
    const text = render([view()]);
    expect(text).toContain('- `strong` (`codex` `gpt-6.1-sol` `high`): done, 339.4 s, tokens in 5000, cached 4000, out 300, cost n/a');
    expect(text).toContain('- `cheap-claude` (`claude-code` `claude-sonnet-5-5` `low`): done, 41 s, tokens in 100, cached 0, out 10, cost $0.0200');
    expect(text).toContain('- `P1` `Crash on an empty list` (2 seats) at `src/a.ts:10`. Triage: `valid` `Will fix it.`');
    const none = render([view({}, { triage: null, triage_reason: null, reviewer_count: 1 })]);
    expect(none).toContain('(1 seat) at `src/a.ts:10`. Triage: none');
  });

  it('names the lens and marks shadow seats and shadow findings as plain text, and counts shadow findings apart', () => {
    const lensSeat = { seat: 'lens-contracts', kind: 'lens', runtime: 'claude-code', family: 'claude', model: 'claude-haiku-5-5', effort: 'medium', lens: 'contracts', shadow: true, note: null, status: 'failed', secs: 2, tokens: { in: 10, cached: 0, out: 1, cost_usd: null }, error: 'timed out' };
    const v = view({ seats: [...view().seats, lensSeat], findings: [view().findings[0], { ...view().findings[0], finding_id: 'fnd_2', severity: 'P0', title: 'Shadow claim', reviewers: ['lens-contracts'], reviewer_count: 1, triage: null, triage_reason: null, shadow: true }] });
    const text = render([v, view({ round: 2 })]);
    expect(text).toContain('- `lens-contracts` (`claude-code` `claude-haiku-5-5` `medium`, lens `contracts`, shadow): failed, 2 s');
    expect(text).toContain('- Shadow, never blocks: `P0` `Shadow claim` (1 seat) at `src/a.ts:10`. Triage: none');
    expect(text).toContain('Findings (2, P0 0, P1 1, P2 0, P3 0, shadow 1):');
    // An older round shrinks to one line with the same counts.
    expect(render([v, view({ round: 2 })], 900)).toMatch(/Round 1 .*findings: P0 0, P1 1, P2 0, P3 0, shadow 1/);
  });

  it('is the same text for the same input, with the same marker', () => {
    expect(render([view()])).toBe(render([view()]));
    expect(render([view()]).split('\n')[0]).toBe(render([view(), view({ round: 2 })]).split('\n')[0]);
  });

  it('shortens long site lists', () => {
    const sites = Array.from({ length: 9 }, (_, i) => ({ file: `src/f${i}.ts`, line: i + 1 }));
    const text = render([view({}, { sites })]);
    expect(text).toContain('`src/f4.ts:5` and 4 more');
    expect(text).not.toContain('src/f5.ts');
  });

  it('stays under the cap with a large review: older rounds shrink to one line first, then findings are cut', () => {
    const many = (round: number) => ({
      ...view({ round }),
      findings: Array.from({ length: 400 }, (_, i) => ({ finding_id: `f${i}`, severity: ['P0', 'P1', 'P2', 'P3'][i % 4], title: `Finding ${i} ${'t'.repeat(250)}`, body: 'b', sites: Array.from({ length: 5 }, (_, j) => ({ file: `src/${'d/'.repeat(20)}file${j}.ts`, line: j })), reviewers: ['strong'], reviewer_count: 1, triage: 'valid', triage_reason: 'r'.repeat(290) })),
    });
    const views = [many(1), many(2), many(3)];
    const text = render(views);
    expect(text.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(MAX_COMMENT_CHARS).toBeLessThan(65536);
    expect(text.split('\n')[0]).toBe(reviewCommentMarker(JOB));
    // Older rounds are one line with counts, the newest keeps seats.
    expect(text).toMatch(/^- Round 1 \(.*\): verdict `changes`, 2 seats, findings: P0 100, P1 100, P2 100, P3 100$/m);
    expect(text).toContain('### Round 3');
    expect(text).not.toContain('### Round 1');
    // A comment that cannot fit even with one round in full cuts that round's findings and says so.
    expect(text).toMatch(/more findings not shown/);
  });

  it('keeps every round in full while it fits, and leaves out the oldest lines last', () => {
    const small = [view({ round: 1 }), view({ round: 2 }), view({ round: 3 })];
    const text = render(small);
    expect(text).toContain('### Round 1');
    expect(text).toContain('### Round 3');
    const tiny = render(small, 1400);
    expect(tiny.length).toBeLessThanOrEqual(1400);
    expect(tiny).toContain('### Round 3');
    expect(tiny).toMatch(/^- Round 1 /m);
    const tinier = render(Array.from({ length: 10 }, (_, i) => view({ round: i + 1 })), 1300);
    expect(tinier.length).toBeLessThanOrEqual(1300);
    expect(tinier).toMatch(/\d+ older rounds? left out/);
    expect(tinier).toContain('### Round 10');
  });
});

describe('the delivery card and the tool list', () => {
  const card = readFileSync(join(import.meta.dirname, '../src/guide/deliver.md'), 'utf8');

  it('tells the Senior to post once and to edit that comment by its marker, and says it is a bar', () => {
    expect(card).toContain('## Triglav review comment');
    expect(card).toContain('`gh pr comment <pr> --body-file <file>`');
    expect(card).toContain('`gh api -X PATCH repos/<repo>/issues/comments/<comment id> -F body=@<file>`');
    expect(card).toContain('gh api repos/<repo>/issues/<pr>/comments --paginate');
    expect(card).toContain('<!-- triglav-local-review job=<job id> -->');
    expect(card).toMatch(/Never post a second comment/);
    expect(card).toMatch(/bar, not a hard boundary/);
    expect(card).toContain('get_review_comment');
  });

  it('is served to Seniors and the senior card points at it', () => {
    const senior = loadGuide('http://localhost:7400', 'senior');
    expect(senior).toContain('## Triglav review comment');
    expect(senior).toContain('post the Triglav review comment');
    expect(loadGuide('http://localhost:7400', 'staff')).not.toContain('## Triglav review comment');
  });

  it('names a marker the server builds the same way', () => {
    expect(reviewCommentMarker('job_x')).toBe('<!-- triglav-local-review job=job_x -->');
  });
});

// Runs against a real MySQL: set ORCH_TEST_DATABASE_URL (see README). Skipped otherwise.
describe.skipIf(!TEST_DB_URL)('get_review_comment', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let n = 0;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    const models = [{ id: 'gpt-6.1-sol', label: 's', efforts: ['high'] }, { id: 'gpt-6-luna', label: 'l', efforts: ['low'] }, { id: 'claude-sonnet-5-5', label: 'S', efforts: ['low'] }, { id: 'claude-opus-5-5', label: 'O', efforts: ['high'] }];
    await recordHostRuntimes(env.ctx, { codex: { version: '1', models }, 'claude-code': { version: '2', models } });
    await exec(env.ctx.pool, `DELETE FROM codex_budget`);
    await recordCodexBudget(env.ctx.pool, { used: 10, windowMin: 300, resetsAt: new Date(env.clock.now().getTime() + 3_600_000), weekly: 5, weeklyResetsAt: null, at: env.clock.now() });
    await exec(env.ctx.pool, `UPDATE code_reviews SET status = 'failed' WHERE status = 'running'`);
    await exec(env.ctx.pool, `UPDATE launches SET finished_at = NOW(3), result = 'x' WHERE finished_at IS NULL`);
    await exec(env.ctx.pool, `UPDATE assignments SET status = 'open', owner_agent_id = NULL, lease_expires_at = NULL WHERE status = 'held'`);
  });

  async function setup() {
    const staffReg = await registerAgent(env.ctx, { role: 'staff', nickname: `staff-${++n}`, runtime: 'test' });
    const staff = await authenticate(env.ctx, staffReg.session_token);
    const parent = issue(`RC-${++n}00`, 'Comment target', { children: [issue(`RC-${n}01`, 'Sub')] });
    env.linear.add(parent as any);
    const job = await registerJob(env.ctx, staff, { linearIssue: parent.identifier, repoPath: '/repo', baseBranch: 'main' });
    const [sub] = job.subjob_ids as [string];
    for (const id of [job.job_id, sub]) {
      await updateJob(env.ctx, staff, { jobId: id, status: 'planning' });
      await updateJob(env.ctx, staff, { jobId: id, acceptanceCriteria: 'Works' });
    }
    await updateJob(env.ctx, staff, { jobId: sub, status: 'ready' });
    const ticket = await createSpawnTicket(env.ctx, staff, { jobId: sub, role: 'senior', brief: 'Build it' });
    const reg = await registerAgent(env.ctx, { role: 'senior', nickname: `senior-${++n}`, runtime: 'test', spawnTicket: ticket.spawn_ticket });
    return { staff, senior: await authenticate(env.ctx, reg.session_token), jobId: sub };
  }

  const claudeOut = (findings: object[]) => JSON.stringify({ type: 'result', is_error: false, structured_output: { findings }, usage: { input_tokens: 100, output_tokens: 10 }, total_cost_usd: 0.02 });
  const codexOut = (findings: object[]) =>
    [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ findings }) } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300 } })].join('\n');

  /** One local review: the seats report the given findings (the strong seat's, the cheap seat's). */
  async function review(senior: any, base: string, head: string, strong: object[], cheap: object[] = []) {
    const r = (await requestCodeReview(env.ctx, senior, { worktree: '/home/dev/wt', baseSha: base, headSha: head, notes: 'n' })) as any;
    for (;;) {
      const l: any = await nextLaunch(env.ctx);
      if (!l) break;
      const row = await queryOne(env.ctx.pool, `SELECT seat FROM code_review_runs WHERE id = ?`, [l.run_id]);
      const out = row!.seat === 'strong' ? codexOut(strong) : claudeOut(cheap);
      await recordReviewOutput(env.ctx, l.id, { code: 0, stdout: out, stderr: '', secs: 12 });
    }
    return r.review_id as string;
  }

  const evil = { severity: 'P1', title: '@octocat [x](https://evil.example) <img src=x>\nSecond line', body: 'Secret body text.', sites: [{ file: 'src/a.ts', line: 10 }] };

  it('builds the comment from the database for a passing head and refuses before the gate passes', async () => {
    const { senior, staff, jobId } = await setup();
    await expect(getReviewComment(env.ctx, senior, jobId, HEAD)).rejects.toThrow(/local gate does not pass/);
    const r1 = await review(senior, BASE, HEAD, [evil], []);
    // The review has a blocking finding: no pass, no comment.
    await expect(getReviewComment(env.ctx, senior, jobId, HEAD)).rejects.toThrow(/verdict changes/);
    const view1 = (await getCodeReview(env.ctx, senior, r1)) as any;
    await answerFinding(env.ctx, senior, { reviewId: r1, findingId: view1.findings[0].finding_id, triage: 'valid', reason: 'Will fix it. @team' });
    const head2 = 'c'.repeat(40);
    const r2 = await review(senior, HEAD, head2, [], []);
    expect(((await getCodeReview(env.ctx, senior, r2)) as any).verdict).toBe('ok');

    const out = await getReviewComment(env.ctx, senior, jobId, head2);
    expect(out).toMatchObject({ job_id: jobId, head_sha: head2, marker: `<!-- triglav-local-review job=${jobId} -->`, rounds: 2 });
    expect(out.body.startsWith(`${out.marker}\n`)).toBe(true);
    expect(out.chars).toBe(out.body.length);
    expect(out.body).toContain('Round 1');
    expect(out.body).toContain('Round 2');
    expect(out.body).toContain('verdict `changes`');
    expect(out.body).toContain('verdict `ok`');
    expect(out.body).toContain('cost n/a');
    expect(out.body).toContain('cost $0.0200');
    expect(out.body).not.toContain('Secret body text');
    expect(out.body).not.toMatch(/localhost|https?:\/\/[^`]*$/m);
    // The hostile title and reason are inside code spans, on one line.
    expect(out.body).toContain('`@octocat [x](https://evil.example) <img src=x> Second line`');
    expect(out.body).toContain('`Will fix it. @team`');
    // The same call twice gives the same text.
    expect((await getReviewComment(env.ctx, senior, jobId, head2)).body).toBe(out.body);
    // Staff of the job reads it too.
    expect((await getReviewComment(env.ctx, staff, jobId, head2)).body).toBe(out.body);
    // The head of the failed gate is still refused: a later head that has no review.
    await expect(getReviewComment(env.ctx, senior, jobId, 'd'.repeat(40))).rejects.toThrow(/local gate does not pass/);
    await expect(getReviewComment(env.ctx, senior, jobId, 'xyz')).rejects.toThrow(/40-character/);
    // A running review is not in the comment, a failed one is.
    await exec(env.ctx.pool, `INSERT INTO code_reviews (id, job_id, requested_by, worktree, base_sha, head_sha, round_no, status, verdict, failure, created_at, finished_at) VALUES ('crv_failed1', ?, ?, '/wt', ?, ?, 1, 'failed', 'failed', 'strong (m): usage limit reached', NOW(3), NOW(3))`, [jobId, senior.id, head2, 'e'.repeat(40)]);
    await exec(env.ctx.pool, `INSERT INTO code_reviews (id, job_id, requested_by, worktree, base_sha, head_sha, round_no, status, created_at) VALUES ('crv_running1', ?, ?, '/wt', ?, ?, 1, 'running', NOW(3))`, [jobId, senior.id, head2, 'f'.repeat(40)]);
    const again = await getReviewComment(env.ctx, senior, jobId, head2);
    expect(again.rounds).toBe(3);
    expect(again.body).toContain('Reason: `strong (m): usage limit reached`');
    expect(again.body).not.toContain('ffffffffffff');
  });

  it('refuses a Senior of another job, a replaced Senior, other Staff, and an unknown job', async () => {
    const mine = await setup();
    await review(mine.senior, BASE, HEAD, [], []);
    const other = await setup();
    await expect(getReviewComment(env.ctx, other.senior, mine.jobId, HEAD)).rejects.toThrow(/live assignment/);
    await expect(getReviewComment(env.ctx, other.staff, mine.jobId, HEAD)).rejects.toThrow(/Only a Senior/);
    await expect(getReviewComment(env.ctx, mine.senior, 'job_unknown', HEAD)).rejects.toThrow(/not found/);
    expect((await getReviewComment(env.ctx, mine.staff, mine.jobId, HEAD)).rounds).toBe(1);
    // A Senior whose lease ran out holds nothing any more.
    env.clock.advance(60 * 60 * 24);
    await expect(getReviewComment(env.ctx, mine.senior, mine.jobId, HEAD)).rejects.toThrow(/live assignment/);
    expect((await getReviewComment(env.ctx, mine.staff, mine.jobId, HEAD)).rounds).toBe(1);
  });

  it('refuses a body that holds something that looks like a secret', async () => {
    const { senior, jobId } = await setup();
    const leak = { severity: 'P3', title: 'Token ghp_abcdefghijklmnopqrstuvwxyz0123456789 in the code', body: 'x', sites: [{ file: 'src/a.ts', line: 1 }] };
    await review(senior, BASE, HEAD, [leak], []);
    await expect(buildReviewComment(env.ctx.pool, jobId, HEAD)).rejects.toThrow(/credential/);
    await expect(getReviewComment(env.ctx, senior, jobId, HEAD)).rejects.toThrow(/credential/);
  });

  it('keeps a job with a very large review under the cap', async () => {
    const { senior, jobId } = await setup();
    const findings = Array.from({ length: 100 }, (_, i) => ({ severity: 'P3', title: `Distinct finding number ${i} ${'word'.repeat(30)}${i}`, body: 'b', sites: Array.from({ length: 20 }, (_, j) => ({ file: `src/dir/f${i}-${j}.ts`, line: j + 1 })) }));
    await review(senior, BASE, HEAD, findings, []);
    const out = await getReviewComment(env.ctx, senior, jobId, HEAD);
    // P3 findings never block, so the gate passes and the comment is built.
    expect(out.body.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(out.body).toContain('Round 1');
  });
});
