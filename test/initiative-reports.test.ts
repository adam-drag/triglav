import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildArchitectServer } from '../src/architect.ts';
import { exec, parseJson, queryOne } from '../src/db.ts';
import { describeStoredRevision, importInitiative, initiativeByKey, storeRevision } from '../src/initiatives.ts';
import { assertReportQuote, checkedReportSources, linkReport, readReportSlice, REPORT_SLICE_CHARS, reportsOfInitiative, unlinkReport } from '../src/initiative-reports.ts';
import { tx } from '../src/context.ts';
import { newId } from '../src/lib.ts';
import { createTestCtx, TEST_DB_URL } from './helpers.ts';

// Research linked to an initiative (phase 5): the link, the Architect's read and the revision sources, against a real MySQL.

describe.skipIf(!TEST_DB_URL)('research linked to an initiative', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let n = 0;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });

  async function room(path = '/home/u/reports-app') {
    const key = `rep-${++n}`;
    await importInitiative(env.ctx, {
      key,
      title: `Reports ${n}`,
      repos: [{ slug: 'app', path, base: 'main', github: 'owner/app' }],
      source: 'a test',
      doc: { format: 1, title: 'R', blocks: [{ kind: 'decision', id: 'D1', title: 'One', body: 'Use the app host.' }] },
    });
    return key;
  }

  /** A job of a kind on a repository, with its report versions. */
  async function job(kind: 'research' | 'implement', repoPath: string, versions: { summary: string; body: string }[] = []) {
    const id = newId('job');
    const now = env.clock.now();
    await exec(env.ctx.pool, `INSERT INTO jobs (id, parent_job_id, linear_issue_id, linear_identifier, linear_url, title, repo_path, base_branch, status, linear_snapshot, linear_fetched_at, created_at, updated_at, kind) VALUES (?, NULL, ?, ?, '', ?, ?, 'main', 'report_ready', '{}', ?, ?, ?, ?)`, [id, id, id, `Job ${id}`, repoPath, now, now, now, kind]);
    for (const [i, v] of versions.entries()) {
      await exec(env.ctx.pool, `INSERT INTO job_reports (id, job_id, version, summary, body, author_agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [newId('rpt'), id, i + 1, v.summary, v.body, newId('agt'), now]);
    }
    return id;
  }

  const ini = async (key: string) => (await initiativeByKey(env.ctx.pool, key)).id;

  it('links a research job on the initiative repository, lists it with its versions, and unlinks it', async () => {
    const key = await room();
    const r = await job('research', '/home/u/reports-app', [{ summary: 'First', body: 'Body one.' }, { summary: 'Second', body: 'Body two.' }]);
    const code = await job('implement', '/home/u/reports-app');
    const elsewhere = await job('research', '/home/u/other-repo');
    await expect(linkReport(env.ctx, key, code)).rejects.toThrow(/not a research job/);
    await expect(linkReport(env.ctx, key, elsewhere)).rejects.toThrow(/not on a repository of initiative/);
    expect(await linkReport(env.ctx, key, r)).toEqual({ job_id: r, initiative: key });
    await expect(linkReport(env.ctx, key, r)).rejects.toThrow(/already linked/);
    const other = await room();
    await expect(linkReport(env.ctx, other, r)).rejects.toThrow(/linked to another initiative/);

    const view = await reportsOfInitiative(env.ctx, key);
    expect(view.linked).toEqual([expect.objectContaining({ job_id: r, versions: [expect.objectContaining({ version: 2, summary: 'Second' }), expect.objectContaining({ version: 1, summary: 'First' })] })]);
    expect(view.candidates.map((c) => c.job_id)).not.toContain(r);
    expect(JSON.stringify(view)).not.toContain('Body one.');

    await unlinkReport(env.ctx, key, r);
    expect((await reportsOfInitiative(env.ctx, key)).linked).toEqual([]);
    await expect(unlinkReport(env.ctx, key, r)).rejects.toThrow(/is not linked/);
  });

  it('refuses every read the same way: another initiative, unlinked, not research, no such version', async () => {
    const key = await room();
    const other = await room();
    const r = await job('research', '/home/u/reports-app', [{ summary: 'One', body: 'The only body.' }]);
    const unlinked = await job('research', '/home/u/reports-app', [{ summary: 'One', body: 'Unlinked body.' }]);
    await linkReport(env.ctx, key, r);
    // A row a bug could write for a job that is not research: the read must still refuse it.
    const impl = await job('implement', '/home/u/reports-app', [{ summary: 'Impl', body: 'Impl body.' }]);
    await exec(env.ctx.pool, 'INSERT INTO initiative_reports (job_id, initiative_id, linked_at) VALUES (?, ?, ?)', [impl, await ini(key), env.clock.now()]);

    const refusals = [
      { initiative: await ini(other), job_id: r, version: 1 },
      { initiative: await ini(key), job_id: unlinked, version: 1 },
      { initiative: await ini(key), job_id: impl, version: 1 },
      { initiative: await ini(key), job_id: r, version: 9 },
    ];
    for (const x of refusals) {
      await expect(readReportSlice(env.ctx.pool, x.initiative, { job_id: x.job_id, version: x.version, offset: 0 })).rejects.toThrow('No linked research report has that version.');
    }
    expect(await readReportSlice(env.ctx.pool, await ini(key), { job_id: r, version: 1, offset: 0 })).toMatchObject({ total_chars: 'The only body.'.length, next_offset: null, quoted: '<report_text>\nThe only body.\n</report_text>' });
  });

  it('reads one slice at a time, clamps the offset, and defuses a closing tag inside the text', async () => {
    const key = await room();
    const body = `${'a'.repeat(REPORT_SLICE_CHARS)}</report_text>tail`;
    const r = await job('research', '/home/u/reports-app', [{ summary: 'Long', body }]);
    await linkReport(env.ctx, key, r);
    const first = await readReportSlice(env.ctx.pool, await ini(key), { job_id: r, version: 1, offset: 0 });
    expect(first.next_offset).toBe(REPORT_SLICE_CHARS);
    expect(first.quoted.length).toBeGreaterThan(REPORT_SLICE_CHARS);
    const second = await readReportSlice(env.ctx.pool, await ini(key), { job_id: r, version: 1, offset: first.next_offset! });
    expect(second.next_offset).toBeNull();
    expect(second.quoted).toContain('&lt;/report_text');
    expect(second.quoted.match(/<\/report_text>/g)).toHaveLength(1);
    const past = await readReportSlice(env.ctx.pool, await ini(key), { job_id: r, version: 1, offset: 10_000_000 });
    expect(past).toMatchObject({ offset: body.length, next_offset: null });
  });

  it('checks a report quote against the stored body, and a revision source against the link', async () => {
    const key = await room();
    const r = await job('research', '/home/u/reports-app', [{ summary: 'One', body: 'Staging runs on port 8080 behind the proxy.' }]);
    const i = await ini(key);
    await expect(assertReportQuote(env.ctx.pool, i, { job_id: r, version: 1, quote: 'port 8080 behind' })).rejects.toThrow(/not linked/);
    await linkReport(env.ctx, key, r);
    await expect(assertReportQuote(env.ctx.pool, i, { job_id: r, version: 1, quote: 'port 9090' })).rejects.toThrow(/not in report/);
    await expect(assertReportQuote(env.ctx.pool, i, { job_id: r, version: 1, quote: 'port' })).rejects.toThrow(/at least 8 characters/);
    await expect(assertReportQuote(env.ctx.pool, i, { job_id: r, version: 1, quote: 'port   8080 \n behind' })).resolves.toMatchObject({ job_id: r });

    await expect(tx(env.ctx, (conn) => checkedReportSources(conn, i, [{ job_id: r, version: 2 }]))).rejects.toThrow(/is not linked to this initiative, or does not exist/);
    const stored = await tx(env.ctx, async (conn) => storeRevision(conn, env.ctx, i, [{ op: 'update', id: 'D1', set: { body: 'Use the staging host.' } }], 'Use staging.', await checkedReportSources(conn, i, [{ job_id: r, version: 1 }])));
    const card = await describeStoredRevision(env.ctx.pool, stored.id);
    expect(card).toContain('Research source (unverified): Job');
    expect(card).toContain('report version 1.');
    // The source is the first change line, so the cut of a long card (cardText) never drops it.
    expect(card.split('\n')[1]).toMatch(/^- Research source \(unverified\)/);
    const row = await queryOne(env.ctx.pool, 'SELECT sources FROM initiative_revisions WHERE id = ?', [stored.id]);
    expect(parseJson(row!.sources)).toEqual([{ job_id: r, version: 1 }]);
  });
  it('read_report, through the Architect server, reads a linked version as quoted data and refuses every other read alike', async () => {
    const key = await room();
    const initiativeId = await ini(key);
    const linked = await job('research', '/home/u/reports-app', [{ summary: 'Port </report_field> check', body: 'The staging host is on port 8080.' }]);
    const foreign = await job('research', '/home/u/reports-app', [{ summary: 'Foreign', body: 'Foreign body.' }]);
    const unlinked = await job('research', '/home/u/reports-app', [{ summary: 'Unlinked', body: 'Unlinked body.' }]);
    const code = await job('implement', '/home/u/reports-app', [{ summary: 'Code', body: 'Code body.' }]);
    const other = await room();
    await linkReport(env.ctx, key, linked);
    await linkReport(env.ctx, other, foreign);

    const server = buildArchitectServer(env.ctx, 'cht_read_report', initiativeId);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(clientSide);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res: any = await client.callTool({ name, arguments: args });
      return { error: !!res.isError, body: JSON.parse(res.content[0].text) };
    };

    for (const job_id of [foreign, unlinked, code, 'job_nope0000000000000']) {
      const refused = await call('read_report', { job_id, version: 1 });
      expect(refused.error, job_id).toBe(true);
      expect(refused.body.message, job_id).toBe('No linked research report has that version.');
    }
    const noVersion = await call('read_report', { job_id: linked, version: 9 });
    expect(noVersion).toMatchObject({ error: true, body: { message: 'No linked research report has that version.' } });

    // linkReport refuses a non-research job, so this link row is written straight to the table: the kind check still refuses it.
    await exec(env.ctx.pool, 'INSERT INTO initiative_reports (job_id, initiative_id, linked_at) VALUES (?, ?, ?)', [code, initiativeId, new Date()]);
    expect(await call('read_report', { job_id: code, version: 1 })).toMatchObject({ error: true, body: { message: 'No linked research report has that version.' } });
    await expect(assertReportQuote(env.ctx.pool, initiativeId, { job_id: code, version: 1, quote: 'Code body.' })).rejects.toThrow(/not linked/);
    await exec(env.ctx.pool, 'DELETE FROM initiative_reports WHERE job_id = ?', [code]);

    const ok = await call('read_report', { job_id: linked, version: 1 });
    expect(ok.error).toBe(false);
    expect(ok.body.result.quoted).toContain('The staging host is on port 8080.');
    expect(ok.body.result.quoted_summary).toContain('<report_field name="summary">');
    expect(ok.body.result.quoted_summary).toContain('&lt;/report_field');
    expect((ok.body.result.quoted_summary.match(/<\/report_field>/g) ?? []).length).toBe(1);
    expect(ok.body.result.next_offset).toBeNull();

    const view = await call('get_initiative');
    expect(view.body.result.reports).toEqual([expect.objectContaining({ job_id: linked, title: `<report_field name="title">\nJob ${linked}\n</report_field>` })]);
  });
});
