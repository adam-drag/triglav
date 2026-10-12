/**
 * Live check with real agent CLIs. Seeds a Staff, a job and a Senior (scripted), waits so that real
 * researchers are already in a long wait, opens a timed question, waits for the deadline, and reports
 * which real agents answered in time. Point it at a stack that is safe to write to (the e2e stack).
 *
 *   node scripts/live-check.ts --delay 90 --window 120 --expect 2
 */
import { parseArgs } from 'node:util';
import { BASE, SimAgent, spawnSenior, staffWithJob } from '../e2e/sim.ts';

const { values } = parseArgs({ options: { delay: { type: 'string', default: '60' }, window: { type: 'string', default: '120' }, expect: { type: 'string', default: '1' } } });
const delay = Number(values.delay);
const windowSec = Number(values.window);
const expected = Number(values.expect);
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const { staff, a } = await staffWithJob('live-check');
const senior = await spawnSenior(staff, a, 'senior-live-check');
log(`Seeded job ${a} on ${BASE}. Waiting ${delay}s before asking, so researchers are mid-wait.`);
await new Promise((r) => setTimeout(r, delay * 1000));

const q = await senior.call('ask_question', {
  job_id: a,
  title: 'Live check: date format in export file names',
  summary: 'Live check of the orchestrator. The export endpoint names files like report-<date>.pdf. Criteria: export works and has tests.',
  question: 'Should the date in export file names be ISO 8601 (2026-10-07) or the user locale format? Reply with a stance and one reason.',
  why_it_matters: 'File names must sort correctly and be safe on every OS.',
  waiting_work: 'Naming the exported files',
  options: 'ISO 8601, or the user locale format',
  window_sec: windowSec,
  requires_staff_decision: false,
});
log(`Asked ${q.thread_id}, deadline ${q.deadline_at}.`);

let result: any;
do {
  result = await senior.call('await_question', { thread_id: q.thread_id, max_wait_sec: 50 });
} while (!result.window_closed);

const roster: any[] = await staff.call('list_agents', { include_inactive: true });
const byId = new Map(roster.map((r) => [r.id, r]));
const replies = result.thread.messages.filter((m: any) => m.type !== 'question');
for (const m of replies) {
  const who = byId.get(m.author);
  log(`${who?.nickname ?? m.author} (${who?.runtime ?? '?'}) stance=${m.stance} timely=${m.timely} :: ${String(m.body).slice(0, 120)}${m.reason ? ` | reason: ${String(m.reason).slice(0, 120)}` : ''}`);
}
const real = replies.filter((m: any) => m.timely && byId.get(m.author)?.runtime !== 'e2e');
log(`State ${result.state}. Timely replies from real agents: ${real.length} (expected at least ${expected}).`);
await Promise.all([staff.close(), senior.close()]);
process.exit(real.length >= expected ? 0 : 1);
