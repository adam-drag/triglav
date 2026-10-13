/**
 * A file that holds a credential for a process the runner starts (an MCP config with a bearer token).
 *
 * The credential must not go on the command line, where any local user can read it with `ps`. It goes in a file that only
 * this user can read, and the command gets the path. The file lives in a new directory (mode 0700) and is created with
 * mode 0600, so it is never readable by others, not even for a moment. `remove` is safe to call twice.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type PrivateFile = { path: string; remove: () => void };

export function writePrivateFile(name: string, content: string): PrivateFile {
  const dir = mkdtempSync(join(tmpdir(), 'triglav-'));
  const path = join(dir, name);
  try {
    writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
