#!/usr/bin/env node
// A stand-in for `gh` in the initiative jobs e2e test. It logs its argv to STUB_GH_LOG and prints STUB_GH_ANSWER, or fails
// the way gh does for a pull request it cannot find when no answer is set.
import { appendFileSync } from 'node:fs';

if (process.env.STUB_GH_LOG) appendFileSync(process.env.STUB_GH_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
if (!process.env.STUB_GH_ANSWER) {
  process.stderr.write('no pull requests found\n');
  process.exit(1);
}
process.stdout.write(process.env.STUB_GH_ANSWER);
