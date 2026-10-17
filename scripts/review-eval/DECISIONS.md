# Review evaluation: decision log

Decisions about the review evaluation harness and the review panel work around it. Each entry says what was decided, by whom, and when to look at it again. Reasons are recorded only when the person who decided gave them.

## Scope of this work (2026-10-17)

- **Decided by:** the Client.
- **Decision:** This work builds evaluation infrastructure and production visibility. It makes no new review-model run. It shows no improvement in review quality and no parity with Copilot.
- **In scope:** a reproducible harness (manifests, production seat mode, admission budget, bounded concurrency, retry accounting), precision scoring with bounds, more fixtures with a dev or held-out split, and single-reviewer judgments of the open baseline findings. A second pull request adds finding provenance, an advisory "unknown" resolution status and more detail in the Reviews UI.
- **Out of scope:** the verifier (plan step G) and any change to the gate (plan step H), the round limits, the reviewer tools, the MCP servers or the default panel.
- **Revisit:** when someone proposes a paid experiment.

## Incomplete reviewer output is shown, not failed (2026-10-17)

- **Decided by:** the Client, as an interim measure.
- **Decision:** A seat with findings the parser rejected, or with findings that kept no valid site, still counts toward the gate as before. The harness lists such seats in their own section and keeps them in the totals. Only a seat that failed is in the failure count. The harness never counts them as clean.
- **Alternatives:** fail the seat (the review fails and the panel runs again), or add a non-passing "incomplete" state. Both change the gate.
- **Open:** stricter handling is an unresolved policy decision.

## The budget is an admission stop (2026-10-17)

- **Decision:** `--budget-tokens` stops starting new work when the next fixture's estimate does not fit. It is not a hard live cap: a running seat is never stopped and is charged in full. Failed and retried attempts count. An attempt that ran without reporting usage is charged its estimate.
- **Unit:** input tokens with the cached ones, plus output tokens. Cache reads count at full weight.
- **Open:** the Client has not set a budget amount, and has not said whether cache reads should count at a lower weight. Both are needed before the first paid experiment.

## Fixture split (2026-10-17)

- **Decision:** PRs 3, 5, 6, 8 and 11 are `dev`. PRs 1, 7 and 19 are `held-out`.
- **Reasoning (the implementer's):** the three PRs with stored runs must be dev, because their numbers were already read. The held-out set mixes a large diff (PR 1), a medium one (PR 7) and a small one (PR 19), and has 5 Copilot findings.
- **Rule:** tune prompts and panels on dev only. Run held-out once, on a frozen candidate.
- **Revisit:** when fixtures are added.

## Round 1 only for PRs 1 and 5 (2026-10-17)

- **Decision:** PRs 1 and 5 record only Copilot's first round. Their later rounds reviewed code written after the first review, and no reader has checked which of those findings were already true at the round 1 head. Recording them without that check would make the ceiling numbers wrong.
- **Revisit:** when someone reads those later rounds at the round 1 head.

## Privacy edits to existing fixtures (2026-10-17)

- **Decision:** three phrases in fixture descriptions were reworded: a ticket key of another tracker in PR 8 ("one job" now), a local launch id in PR 8 (`staff-req_<id>` now), and a home directory path in PR 6 ("a fake home" now). The meaning is the same. The stored baseline seats saw the old wording, which differs by a few characters. A local job id was also removed from the baseline judgments' `judged_by` text.

## The four open baseline findings (2026-10-17)

- **Decision:** one reader read the code at the fixture head and judged each finding. These are single-reviewer judgments. A second reader is reserved for disputed cases that change a result.
- **Results:**
  - tg6 strong#0 (replacement Staff for a resumable offline owner): valid, P2 (the seat said P1).
  - tg6 strong#4 (cancellation errors hidden during start progress): valid, P3 (the seat said P2).
  - tg6 strong#5 (no test for Client questions without the optional fields): valid, P2.
  - tg3 strong#1 (queued rows not refreshed when the runner changes their status): stays `partial` against Copilot's finding, and the defect is valid, P2.
- Each judgment has its evidence in `judgments/baseline.json`.

## The two missing PR 8 findings (2026-10-17)

- **Finding:** the plan counted 4 findings of the cheap Claude seat on PR 8, two of them out-of-diff extras. The stored output has 2 findings for that seat, and both are judged (duplicates of strong#0 and strong#3). No stored text exists for the other two, so they cannot be judged. The baseline numbers here count only the stored findings.

## Deferred decisions

These are open. Each one is needed before the step named.

| Decision | Needed before |
| --- | --- |
| Budget amount, and the weight of cache reads | The first paid experiment |
| Who judges disputed findings, and when a second reader is needed | Comparing two arms |
| Stricter handling of incomplete output (fail the seat, or a new state) | Changing the gate |
| Success measures for a candidate panel | Running the held-out set |
| The default panel, its repeat count and its fallback rules | Changing production defaults |
| Whether a verifier can affect blocking (plan step G) | Building the verifier |
| Gate changes, such as how a "previously missed" finding blocks (plan step H) | Any gate change |
