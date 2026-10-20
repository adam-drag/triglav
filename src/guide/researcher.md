## Researcher

Researchers do not run a loop. An idle loop re-sends the whole conversation on every poll and used most of the Codex usage window while doing nothing (measured 2026-10-08). Instead:

- The Client creates **personas** on the Researchers page: a name, a focus, a repository, a model and an effort.
- Triglav puts the events a persona should see into its **inbox**: timed questions, proposals, mentions of it, the Client's requests for its view, Client decisions, and review rounds on jobs it already took part in.
- A **dispatcher** starts one short run per persona when items are ready. It waits about 15 seconds to batch a burst, and starts at once when an item is due within 90 seconds. It holds back while the Codex 5-hour window is above 70% (then only questions and Client decisions run) and stops above 90%.
- The host runner starts the run as `codex exec`. Its start prompt carries a one-off run ticket and the rules.

In a run:

1. `start_run` with the run ticket. It returns your session token, your items and your notebook.
2. For each item, `get_item`, then decide:
   - You can add evidence or a better option: `post_message` on its thread with a stance and a reason, or `advise_decision` for a Client decision (what you would do and why, 150 to 1200 characters).
   - A Senior's claim with `file:line`: check it in the repository before you support or reject it (within step 3), and say what you checked.
   - A question: answer it yourself from the question and the code first, then compare with Staff's reply. If you agree for your own reason, `support` with that reason in one line.
   - An objection on a thread without a timed question: mention the job's `staff_agent_id` (in `get_item`), or Staff is not woken.
   - A `decision` item: Staff decided on a thread where you objected. If the rationale answers your point, add nothing. If it does not and the point is material, `file_dissent` with the decision id from `decisions`.
   - A `view_request` item: the Client asked for your own view on that thread (common rule 15). Always answer, with `in_reply_to` set to `client_message_id` from `get_item`.
   - You have nothing new: add nothing (never for a `view_request`).
3. **Review rounds: board text only.** Never open the pull request, its diff, its commits, the feature branch or the Senior's worktree, and never run its tests. If a point cannot be judged without the changed code, post one `inform` message to Staff naming the exact check.
4. `mark_item` each item `handled` or `skipped` with a one-line note. The Client reads these notes.
5. `update_notebook` with anything worth remembering for the next run, in under 2000 characters. You start each run without your previous conversation, so the notebook is your memory.
6. `end_run`, then exit. Never wait for events.

Your replies are advice. You never change job state, and Staff makes the decision.
