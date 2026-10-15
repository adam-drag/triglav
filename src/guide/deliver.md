
## Delivery loop: Copilot review in at most 3 rounds

This is the loop from step 8 of the Senior card. It works on a GitHub repository where Copilot code review is enabled. You run it yourself with `gh`, in your worktree, on the open PR.

**Two gates sit in front of every Copilot round.**

- **The local gate.** Before every Copilot request, a local code review (`request_code_review`) must have passed on the exact head sha you push. `request_copilot_review` refuses without it. The rules for local rounds are on the Senior card (step 6): at most 3 rounds for one piece of work, and every round after the first reviews only the fix delta. The reviewed ranges of a job are one chain: the first piece starts at the merge base with the job's base branch and a later piece at the last passing head, so the whole PR has been reviewed before Copilot sees it.
- **The Copilot counts.** At most 3 Copilot rounds per PR. Stop at "Approval recommended". Never request a round only for P3 findings or findings Copilot labels "Previously missed": fix those locally, pass the local gate, and finish. You tell the server about each round with `request_copilot_review` before the `gh` request and `record_copilot_result` after you read the review, and the server refuses a request that breaks these rules.

**This is a bar, not a hard boundary.** You still have `gh`, so nothing stops you from running `gh pr edit` without asking the server. The server only sees the calls you make, and the counts you record are your own report of the review. Do not use `gh` to skip the gate, and do not report counts you did not read. Skipping a round that the server would refuse is a protocol break, not a shortcut.

**First, the review mode.** `get_job` returns `review_mode`, which the Client sets:

- `copilot`: the loop is required. You cannot report delivery without it (the orchestrator refuses `SKIPPED`). If Copilot does not answer, raise a blocker that says so and offers the Client two ways out: wait and retry, or change the review mode to CI only.
- `ci_only`: do not run the loop. Wait for green CI on the head commit, then report delivery with `copilot_status` `SKIPPED` and a `copilot_summary` that says the Client chose CI only.
- `auto`: decide from evidence. Look for Copilot reviews on the repository's recent PRs: `gh api "repos/<repo>/pulls?state=all&per_page=10" --jq '.[].number'`, then for each number `gh api repos/<repo>/pulls/<n>/reviews --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]")] | length'`. If at least one PR has a Copilot review, run the loop below. If none has, Copilot is probably not enabled here: do not request one, wait for green CI, and report `SKIPPED` with a `copilot_summary` that names what you checked (for example "no Copilot review on the last 10 PRs"). If you are unsure, run the loop: a request that fails or gets no answer ends in a blocker as below, and the Client decides.

The local gate applies in every mode, also when no Copilot round runs: `submit_review_package` already needed it. In every mode the PR needs green CI on the head commit before you report delivery, and Staff checks it again. A correct PR is the goal, not a clean-looking review: a round that ends with "all findings were false positives, here is why" is a good round.

**Setup.** Let `<pr>` be the PR number and `<repo>` the `owner/name` (`gh repo view --json nameWithOwner --jq .nameWithOwner`). Find the repository's own gate: read its CI workflows (for example `.github/workflows/`) and note the format, lint, type and test commands. Run all of them before every push. Keep a list of the review ids you have already triaged (`seen`) and put it, with the Copilot round number (1 to 3), in every `report_progress` note, so a restart can carry on.

**One round**

1. **Local gate and CI first.** The head you push has a passing local review (`request_code_review`, then `answer_finding`; see the Senior card). When CI runs on every push, wait until every check on the head commit has finished: `gh pr checks <pr> --watch`, or poll `gh api repos/<repo>/commits/<head sha>/check-runs`. While CI is red or still running, do not request a review. Fix the failure, pass the local gate on the fix, push, wait again. If the repository queues CI only on request or on "ready for review", skip the CI wait and do not mark the PR ready yourself: that is the Client's call.
2. **Read what is already there.** Copilot also reviews on its own, so a review can arrive between rounds. List the Copilot reviews and compare their ids with `seen`:
   `gh api repos/<repo>/pulls/<pr>/reviews --paginate --jq '.[] | select(.user.login == "copilot-pull-request-reviewer[bot]") | .id'`
   Never track reviews by time, only by id. Triage every review that is not in `seen` before you request a new one. A review that Copilot wrote on its own counts as a round: call `request_copilot_review` for the head it reviewed (bookkeeping only: do not run the `gh` request), then read it and call `record_copilot_result` as in steps 5 to 7. If the server refuses that call, read the reason: the loop may already be over, or that head never passed the local gate (then fix and gate it before anything else).
3. **Ask the server, then request the review.** Call `request_copilot_review` with `pr` and the full `head_sha` of the PR head. Only when it answers ok, run:
   `gh pr edit <pr> --add-reviewer "@copilot"`
   If the server refuses, the reason says why (no passing local review on that head, 3 rounds used, approval recommended, no qualifying finding left, or the last round has no recorded result). Do not request Copilot with `gh` anyway. If the `gh` command fails on a draft PR, report the error in a blocker and stop; do not mark the PR ready to work around it.
4. **Wait for it,** at most 10 minutes. Poll the list from step 2 every 30 to 60 seconds, and call `report_progress` at least every 5 minutes so your lease stays alive. If no new review has arrived after 10 minutes, raise a blocker saying Copilot did not answer, and stop. Silence is not approval: never report a clean review that you did not read. Do not request again. The blocker should say that the Client can wait, or change the review mode to CI only, and that you will carry on when they answer.
5. **Read everything, not only inline comments.** For each new review id, print the whole body and its inline comments:
   `gh api repos/<repo>/pulls/<pr>/reviews/<id> --jq .body`
   `gh api repos/<repo>/pulls/<pr>/comments --paginate --jq '.[] | select(.pull_request_review_id == <id>) | "\(.path):\(.line // .original_line) \(.body)"'`
   Many findings sit in the review body, for example under a "Suppressed comments" heading, and a round that reads only inline comments looks clean while real defects wait in the body. Copilot's reviews have the state `COMMENTED`. It never approves or requests changes, so do not wait for a verdict. It can write "Approval recommended" in the body: look for that text.
6. **Triage each finding before you touch code:** say `valid`, `debatable` or `invalid`, with a one-line reason, and give each one a severity P0 to P3 (P0 breaks everything or is a security hole, P1 a bug users will hit, P2 a real defect in a narrower case, a missing test or a broken written rule, P3 minor). Read the lines it cites and check the claim against the code: a confident finding can be wrong about what the code does. A convention the repository documents (its contributing guide, `.github/copilot-instructions.md`, its agent instructions) beats the bot. Findings that are not clear-cut go to Staff as described on the Senior card.
7. **Record the round.** Call `record_copilot_result` with the round number, whether the review says "Approval recommended", the count of valid findings per severity (`P0` to `P3`), and `previously_missed`: how many of the valid P0-P2 findings Copilot labelled "Previously missed". Count only what you read. The tool says whether another round is allowed.
8. **Fix the valid ones, locally.** For a behaviour bug write the failing test first, then fix. Run the whole gate from the setup. Commit, then pass the local gate on the new head (`request_code_review`; the Senior card has the rules). Push once.
9. **Mark the round's reviews as seen** (add their ids to `seen`) only after every finding in them is triaged. Then decide:
   - Approval recommended, or no valid P0-P2 finding that was not "Previously missed": the loop is over. Do not request another round. Go to "When the loop ends".
   - At least one valid P0-P2 finding that was not "Previously missed", and fewer than 3 rounds used: start the next round at step 1, because the push changed the code and CI has to pass on the new head.
   - Round 3 used and valid P0-P2 findings left: you fixed them in step 8 and passed the local gate. No fourth round: go to "When the loop ends".

P3 findings and "Previously missed" findings never earn a round. You fix them in step 8 with the local gate, and the loop still ends.

**When the loop ends**

- **Clean:** the last round recommended approval, or left no valid P0-P2 finding that was not "Previously missed", or it was round 3 and you fixed every valid finding of it locally. You fixed or answered every finding, passed the local gate on the head you pushed, and CI is green on that head. Check that commit again (`gh pr view <pr> --json headRefOid --jq .headRefOid`, then its check runs) and report delivery with `copilot_status` `DONE`, as the Senior card says.
- **Stopped:** 3 rounds are used and a valid P0-P2 finding is still open that you cannot fix locally, or the same finding keeps returning, or a fix causes the next finding. Raise a `failed_execution` blocker with your triage of every open finding and what you tried. Do not start a fourth round.
- **Blocked:** CI fails for a reason outside your change, or something you cannot do (a permission, a missing setting) stops you. Raise a blocker that says what is needed.

Never report delivery with a failing or missing check. Do not merge, mark the PR ready, or change repository settings.
