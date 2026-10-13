#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for the Operator e2e test.
// It answers each user message with a canned reply, streamed word by word, and logs how it was started to STUB_LOG.
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
// The runner also calls `claude agents --json` and `claude stop <id>` for a confirmed stop-session request.
if (args[0] === 'agents') {
  console.log(JSON.stringify([{ id: 'c6a5f9cb', kind: 'background', name: 'staff-stub', state: 'blocked' }]));
  process.exit(0);
}
if (args[0] === 'stop') {
  if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, JSON.stringify({ stop: args[1] }) + '\n');
  process.exit(0);
}
const resumed = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const session = resumed ?? randomUUID();
// --mcp-config is a path to a private file that the runner removes when this process ends, so read it now.
const mcpPath = args[args.indexOf('--mcp-config') + 1];
const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
const mode = (statSync(mcpPath).mode & 0o777).toString(8);
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, JSON.stringify({ args, session, cwd: process.cwd(), mcp, mcpPath, mode }) + '\n');

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let turn = 0;
let started = false;

createInterface({ input: process.stdin }).on('line', async (line) => {
  const text = JSON.parse(line).message.content[0].text;
  turn++;
  if (!started) {
    started = true;
    out({ type: 'system', subtype: 'init', session_id: session });
  }
  let reply;
  if (text.includes('inject')) reply = 'Look: <img src=x onerror=alert(1)> [click](javascript:alert(1)) **bold**';
  else if (text.includes('slow')) reply = Array.from({ length: 100 }, () => 'tick').join(' ');
  else reply = `You said: ${text}. This is turn ${turn} of this process.`;
  const slow = text.includes('slow');
  for (const word of reply.split(' ')) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: word + ' ' } } });
    await wait(slow ? 300 : 15);
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
  out({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply });
});
