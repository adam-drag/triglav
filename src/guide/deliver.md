
## Delivery loop: Copilot review until it is clean

This is the loop from step 8 of the Senior card. It works on a GitHub repository where Copilot code review is enabled. You run it yourself with `gh`, in your worktree, on the open PR.

**First, the review mode.** `get_job` returns `review_mode`, which the Client sets:

- `copilot`: the loop is required. You cannot report delivery without it (the orchestrator refuses `SKIPPED`). If Copilot does not answer, raise a blocker that says so and offers the Client two ways out: wait and retry, or change the review mode to CI only.
- `ci_only`: do not run the loop. Wait for green CI on the head commit, then report delivery with `copilot_status` `SKIPPED` and a `copilot_summary` that says the Client chose CI only.
- `auto`: decide from evidence. Look for Copilot reviews on the repository's recent PRs: `gh api "repos/<repo>/pulls?state=all&per_page=10" --jq '.[].number'`, then for each number `gh api repos/<repo>/pulls/<n>/reviews --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]")] | length'`. If at least one PR has a Copilot review, run the loop below. If none has, Copilot is probably not enabled here: do not request one, wait for green CI, and report `SKIPPED` with a `copilot_summary` that names what you checked (for example "no Copilot review on the last 10 PRs"). If you are unsure, run the loop: a request that fails or gets no answer ends in a blocker as below, and the Client decides.

In every mode the PR needs green CI on the head commit before you report delivery, and Staff checks it again. A correct PR is the goal, not a clean-looking review: a round that ends with "all findings were false positives, here is why" is a good round.

**Setup.** Let `<pr>` be the PR number and `<repo>` the `owner/name` (`gh repo view --json nameWithOwner --jq .nameWithOwner`). Find the repository's own gate: read its CI workflows (for example `.github/workflows/`) and note the format, lint, type and test commands. Run all of them before every push. Allow at most 5 rounds. Keep a list of the review ids you have already triaged (`seen`) and put it, with the round number, in every `report_progress` note, so a restart can carry on.

**One round**

1. **CI first, when CI runs on every push.** Wait until every check on the head commit has finished: `gh pr checks <pr> --watch`, or poll `gh api repos/<repo>/commits/<head sha>/check-runs`. While CI is red or still running, do not request a review. Fix the failure, push, wait again. If the repository queues CI only on request or on "ready for review", skip this step and do not mark the PR ready yourself: that is the Client's call.
2. **Read what is already there.** Copilot also reviews on its own, so a review can arrive between rounds. List the Copilot reviews and compare their ids with `seen`:
   `gh api repos/<repo>/pulls/<pr>/reviews --paginate --jq '.[] | select(.user.login == "copilot-pull-request-reviewer[bot]") | .id'`
   Never track reviews by time, only by id. Triage every review that is not in `seen` before you request a new one.
3. **Request a review:** `gh pr edit <pr> --add-reviewer "@copilot"`. If this fails on a draft PR, report the error in a blocker and stop; do not mark the PR ready to work around it.
4. **Wait for it,** at most 10 minutes. Poll the list from step 2 every 30 to 60 seconds, and call `report_progress` at least every 5 minutes so your lease stays alive. If no new review has arrived after 10 minutes, raise a blocker saying Copilot did not answer, and stop. Silence is not approval: never report a clean review that you did not read. Do not request again. The blocker should say that the Client can wait, or change the review mode to CI only, and that you will carry on when they answer.
5. **Read everything, not only inline comments.** For each new review id, print the whole body and its inline comments:
   `gh api repos/<repo>/pulls/<pr>/reviews/<id> --jq .body`
   `gh api repos/<repo>/pulls/<pr>/comments --paginate --jq '.[] | select(.pull_request_review_id == <id>) | "\(.path):\(.line // .original_line) \(.body)"'`
   Many findings sit in the review body, for example under a "Suppressed comments" heading, and a round that reads only inline comments looks clean while real defects wait in the body. Copilot's reviews have the state `COMMENTED`. It never approves or requests changes, so do not wait for a verdict.
6. **Triage each finding before you touch code:** say `valid`, `debatable` or `invalid`, with a one-line reason. Read the lines it cites and check the claim against the code: a confident finding can be wrong about what the code does. A convention the repository documents (its contributing guide, `.github/copilot-instructions.md`, its agent instructions) beats the bot. Findings that are not clear-cut go to Staff as described on the Senior card.
7. **Fix the valid ones.** For a behaviour bug write the failing test first, then fix. Run the whole gate from the setup, then push. One push per round.
8. **Mark the round's reviews as seen** (add their ids to `seen`) only after every finding in them is triaged. Then start the next round at step 1, because the push changed the code and CI has to pass on the new head.

**When the loop ends**

- **Clean:** a new review has no valid finding left, you fixed or answered every earlier one, and CI is green on the head commit. Check that commit again (`gh pr view <pr> --json headRefOid --jq .headRefOid`, then its check runs) and report delivery with `copilot_status` `DONE`, as the Senior card says.
- **Stopped:** after 5 rounds, or when the same finding keeps returning, or when a fix causes the next finding. Raise a `failed_execution` blocker with your triage of every open finding and what you tried. Do not start a sixth round.
- **Blocked:** CI fails for a reason outside your change, or something you cannot do (a permission, a missing setting) stops you. Raise a blocker that says what is needed.

Never report delivery with a failing or missing check. Do not merge, mark the PR ready, or change repository settings.
