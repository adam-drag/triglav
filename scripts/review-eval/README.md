# Review evaluation harness

This harness measures the local review panel against the findings Copilot made on Triglav's own pull requests. It is for people who work on the panel. It runs by hand only: CI does not run it, no package script calls it, and the Docker image does not contain it. Tests check all three.

What it delivers today is evaluation infrastructure. The work that built it (fixtures, manifests, budget checks, precision scoring, four new judgments) made no new review-model run. It shows no improvement in review quality and no parity with Copilot. The numbers below describe the stored baseline and nothing more.

The decisions behind the harness, and the ones still open, are in [DECISIONS.md](DECISIONS.md).

## Commands

```bash
node scripts/review-eval/cli.ts list     # the fixtures, with their split
node scripts/review-eval/cli.ts score    # score the stored baseline (no tokens used)
node scripts/review-eval/cli.ts merge    # what the production mergeFindings makes of the stored output
node scripts/review-eval/cli.ts run --arm NAME --yes [options]   # costs real tokens
node scripts/review-eval/cli.ts score --runs review-eval-out/NAME --judgments FILE --unjudged
```

`run` starts the same reviewers as the host runner. The diff, the prompt, the command and the environment are built by the production functions, so a seat has the runner's access and no Triglav secret. Each fixture runs in a detached worktree at its head under `review-eval-out/`, which git ignores. `run` refuses to start when `CI` is set. It does not read the Codex or Claude plan limits.

### Options of `run`

| Option | What it does |
| --- | --- |
| `--arm NAME` | The name of the arm. Results go to `review-eval-out/NAME/`. A fixture the arm already finished is kept and never paid for twice. |
| `--prompt production\|lean` | The review prompt. `production` (the default) is the text the runner gets from the server. `lean` is a harness-only variant (`lean-prompt.ts`). |
| `--mode fixed\|production` | `fixed` (the default) runs every seat exactly as named; a missing CLI or model makes the seat fail. `production` resolves the seats with `resolveSeats`, the function a real review uses, from the CLIs and models `detectRuntimes` finds on this machine. |
| `--requester codex\|claude-code` | Production mode only: the Senior's runtime, so the strong seat moves to the other family as in a real review. |
| `--codex-used PERCENT` | Production mode only: the Codex window use that `resolveSeats` compares with its stop level. The harness has no database, so it does not read the live value. |
| `--repeat N` | A label from 1 to 99 for repeated runs of one arm. It goes into the manifest, and a rerun with another repeat is refused. |
| `--budget-tokens N` | The admission budget, in tokens (below). |
| `--concurrency N` | How many reviewer processes run at once, 1 to 16. The default is every seat of a fixture at once. |
| `--retries N` | How many times a failed attempt of a seat runs again, 0 (the default) to 3. |
| `--fixtures a,b`, `--seats a,b` | A subset. Seat names are the panel's (`strong`, `cheap-claude`), plus `strong-2` to `strong-4` for repeat members. |

A rerun of an arm checks the stored fixtures before anything starts. It refuses when they used another prompt, mode or repeat.

## The budget is an admission stop, not a hard cap

`--budget-tokens` counts input tokens (cached ones included) plus output tokens. Before each fixture, the harness estimates every seat from the diff size (`SEAT_ESTIMATE` in `run.ts`) and reserves that estimate. When the estimate does not fit in what is left, the harness starts nothing more, prints which fixtures it did not start, and exits with code 2.

It does not stop a reviewer that is already running. A seat that uses more than its estimate is charged in full, so the total can go over the budget by that excess. Use a budget below the amount you can afford.

Every attempt counts:

- An attempt that reported usage is charged that usage, even when it failed.
- An attempt that ran but reported no usage is charged its estimate, because it may have spent tokens. The scorer counts such attempts and says their tokens are unknown, even when a retry of the seat reported usage.
- A process that was killed or printed too much loses its answer, but the usage it printed before that (Codex prints one line per turn) is still read and charged.
- An attempt that never started (the CLI could not be launched, the MCP list failed) is charged nothing.
- A retry reserves its own estimate first. When the budget has no room, the retry is not run, and the seat's error says so.

The estimate was fitted above the three stored baseline runs. It is an upper guess for the default panel's models, not a prediction for other models.

## What a run stores

`review-eval-out/NAME/<fixture>.json` is one run: the seats' parsed findings and usage, plus two manifests.

- The run manifest has the mode, the repeat, the harness revision and whether the checkout had uncommitted changes, the SHA-256 of the diff, the requester runtime, the Codex window value, the seats `resolveSeats` dropped, and the start and finish times.
- Each seat manifest has the CLI version, the requested and the effective runtime, model and effort, the fallback reason, the SHA-256 of the prompt, the repeat, the shuffle seed of a repeat member (`strong-2` and later read the diff's files in a seeded order), the count of findings the parser rejected, the count of findings left with no valid site, the failure reason, and every attempt with its exit code, time, usage and charged tokens.

`raw/` keeps the stdout and stderr of each seat, and of earlier attempts when a seat was retried. Runs stored before the manifest existed have none and count as fixed mode, repeat 1.

## Fixtures

`test/fixtures/review-eval/prs/<id>.json` holds one pull request of this repository: the full base and head sha (the head of Copilot's first review), the title, the PR description cut before anything written after the review, a `split`, and Copilot's findings. Each finding has an id, round, Copilot's own severity (high, medium, low), file, line and a short label in our own words. Never copy Copilot's text, and never add anything from a private repository, a home directory path, a session id or a ticket key of another tracker. A test greps for these.

| Fixture | PR | Split | Copilot findings | Note |
| --- | --- | --- | --- | --- |
| tg1 | 1 | held-out | 3 (round 1) | Round 1 only. Base is the merge base. |
| tg3 | 3 | dev | 3 | Stored baseline run. |
| tg5 | 5 | dev | 4 (round 1) | Round 1 only. Description as it was at review time. |
| tg6 | 6 | dev | 4 in round 1, 8 in all | Stored baseline run. |
| tg7 | 7 | held-out | 1 | Description as it was at review time. |
| tg8 | 8 | dev | 5 in round 1, 8 in all | Stored baseline run. |
| tg11 | 11 | dev | 1 | |
| tg19 | 19 | held-out | 1 | |

A fixture may have no Copilot finding (give a `findings_basis`). It then measures only the panel's noise.

## Judgments

`test/fixtures/review-eval/judgments/<arm>.json` says, per panel finding (`seat#index` and its title, checked against the run), what a reader found:

- `catch`: the same cause and fix as a Copilot finding (names its id).
- `partial`: a related symptom of a Copilot finding. It is not counted as caught.
- `valid`, `invalid`, `unsure`: a finding Copilot did not make. `invalid` is noise. `unsure` counts as unjudged.
- `dup_of`: the finding repeats another one and is counted once.
- `validity` (optional): whether the defect is real, apart from whether it matches Copilot. It must agree with `valid`, `invalid` and `unsure`. Without it, `catch` and `valid` count as valid, `invalid` as invalid, and `partial` and `unsure` as not judged.
- `severity` (optional): the reader's P0 to P3.
- `evidence` (optional): the reviewed sha (must be the run's head), the file and line, the trigger, the expected and the actual behaviour, the reasoning, and `reviewers: single` or `two`.

`misses` (optional) gives a cause for a Copilot finding the panel did not catch: `context`, `retrieval`, `reasoning`, `scope`, `output_loss`, `aggregation` or `unknown`. Use `unknown` when the trace does not show a cause.

## Scoring

Per fixture, in total and per seat:

- **R1 recall**: Copilot round 1 findings caught. **Ceiling recall** adds later-round findings that were already true at the round 1 head.
- **valid**, **noise**, **unjudged**, **dup**, **partial**, **findings**: counts as above. Noise is a floor while anything is unjudged.
- **precision**: valid over valid plus invalid, among unique findings (a duplicate is not counted twice). **bounds** take every finding with no validity judgment as invalid (the pessimistic bound) and then as valid (the optimistic bound).
- Tokens (input with the cached ones apart, and output), wall seconds (the fixture's elapsed time from its run manifest, or the slowest seat for a run without one), seat seconds, and the cost Claude reports (Codex reports none).

Recall comes from summed counts, never from an average of ratios.

**Incomplete seats** are listed in their own section: a seat that failed, a seat whose findings the parser rejected, or a seat with findings that kept no valid site. They still count in the totals above and in the failure count. They are not dropped, and they are not shown as clean reviews.

**Substituted seats.** In production mode, a seat that ran another runtime, model or effort than the arm asked for is not scored under the arm's name. It is scored in its own section, labelled with what ran (for example `strong as claude-code <model> <effort>`). A fixture where every seat was substituted is left out of the arm's rows and totals, and the table names it.

## The stored baseline

`runs/baseline` and `judgments/baseline.json` hold the default panel on PRs 3, 6 and 8, one run per seat, made before this harness had manifests. It scores 7 of 12 round 1 findings and 10 of 17 at the ceiling, with 20 findings, 6 valid extras, no noise, nothing unjudged, 2 duplicates and 1 partial. Precision is 18 of 18 unique findings. Every judgment was made by one reader who knew which seat wrote the finding, so these are single-reviewer judgments.

## Limitations

- One run per seat per fixture. A difference of one or two findings is not a result.
- One reader, not blind to the seat, judged every baseline finding.
- Copilot is the reference, and Copilot misses things too. Recall against Copilot is not recall against all defects.
- The baseline seats of PR 8 saw a description that already listed the fixes to Copilot's round 1 findings. The fixture now cuts it, so a new run of PR 8 is not comparable with the baseline. PR 6's description reached the seats cut at 4000 characters.
- The fixtures are small and all from this repository.
