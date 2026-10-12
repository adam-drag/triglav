/**
 * Sets the dashboard password. It asks for the password twice without echo, hashes it with scrypt and writes only the
 * hash to .env as ORCH_CLIENT_PASSWORD_HASH. Restart the server afterwards (docker compose up -d).
 *
 *   node scripts/set-password.ts            # asks on the terminal
 *   node scripts/set-password.ts --env FILE # another env file, for tests
 *
 * With piped input (not a terminal) the first line of stdin is the password and nothing is asked twice.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/client-auth.ts';

const NAME = 'ORCH_CLIENT_PASSWORD_HASH';

/**
 * Replaces the line for `name` in an env file's text, or appends it. Other lines stay as they are. A repeated line is
 * dropped, so that no stale value is left behind for a later line to win with.
 */
export function upsertEnvLine(text: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*(\\r?\\n|$)`, 'gm');
  if (re.test(text)) {
    let n = 0;
    return text.replace(re, (_m, eol: string) => (n++ === 0 ? `${line}${eol}` : ''));
  }
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`;
}

function ask(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          return reject(new Error('Cancelled.'));
        }
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** The length is counted on what `hashPassword` hashes: NFKC-normalized, in characters, not UTF-16 units. */
function checkLength(password: string): void {
  if ([...password.normalize('NFKC')].length < MIN_PASSWORD_LENGTH) throw new Error(`The password must have at least ${MIN_PASSWORD_LENGTH} characters.`);
}

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    const first = await ask(`New dashboard password (at least ${MIN_PASSWORD_LENGTH} characters): `);
    checkLength(first);
    if ((await ask('Again: ')) !== first) throw new Error('The two entries differ. Nothing was changed.');
    return first;
  }
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const first = text.split('\n')[0]!.replace(/\r$/, '');
  checkLength(first);
  return first;
}

if (import.meta.filename === process.argv[1]) {
  try {
    const i = process.argv.indexOf('--env');
    const file = i >= 0 ? process.argv[i + 1]! : join(import.meta.dirname, '..', '.env');
    const hash = await hashPassword(await readPassword());
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    writeFileSync(file, upsertEnvLine(before, NAME, hash), { mode: 0o600 });
    chmodSync(file, 0o600); // `mode` only applies to a new file; an existing .env may be 0644.
    console.log(`Wrote ${NAME} to ${file}. Restart the server to use it: docker compose up -d`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
