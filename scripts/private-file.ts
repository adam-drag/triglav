/**
 * A file that holds a credential for a process the runner starts (an MCP config with a bearer token).
 *
 * The credential must not go on the command line, where any local user can read it with `ps`. It goes in a file that only
 * this user can read, and the command gets the path. The file lives in a new directory (mode 0700) and is created with
 * mode 0600, so it is never readable by others, not even for a moment. `remove` is safe to call twice.
 *
 * Removal does not depend on the caller alone: `removeAllPrivateFiles` removes every file that is still there (the runner
 * calls it when it shuts down), and `cleanStalePrivateDirs` removes what a runner that was killed left behind.
 */
import { lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type PrivateFile = { path: string; remove: () => void };

/** The directory name starts with this, so the sweep below touches nothing else in the temp directory. */
export const PRIVATE_DIR_PREFIX = 'triglav-run-';

const live = new Set<PrivateFile>();

export function writePrivateFile(name: string, content: string): PrivateFile {
  const dir = mkdtempSync(join(tmpdir(), PRIVATE_DIR_PREFIX));
  const path = join(dir, name);
  try {
    writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const file: PrivateFile = {
    path,
    remove: () => {
      live.delete(file);
      rmSync(dir, { recursive: true, force: true });
    },
  };
  live.add(file);
  return file;
}

/** Removes every private file of this process that is still there. */
export function removeAllPrivateFiles(): void {
  for (const file of [...live]) file.remove();
}

/** Removes the private directories that are older than `maxAgeMs` and that this user owns: what a runner that was killed (SIGKILL, a crash) left behind. Returns how many it removed. */
export function cleanStalePrivateDirs(maxAgeMs = 60 * 60_000, dir = tmpdir(), now = Date.now()): number {
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(PRIVATE_DIR_PREFIX)) continue;
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      // Only a real directory of ours (not a symlink) and only an old one: a runner that is running now may have fresh ones.
      if (!st.isDirectory() || st.uid !== process.getuid?.() || now - st.mtimeMs < maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Gone already, or not ours to remove.
    }
  }
  return removed;
}
