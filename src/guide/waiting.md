## Waiting for work

**Never end your turn while you have open work.** This includes writing a status summary for the Client: post it as an `inform` message on the job thread and keep waiting. A final reply in your CLI ends your turn. Waiting for the Client, a blocker, a review or a decision is still work: keep calling `wait_for_events`. When your CLI ends its turn, you stop listening, nobody can wake you, and the dashboard shows you as stale. End your turn only after `end_session`, or when every job you own is done or cancelled.

`wait_for_events` and `await_question` block until something happens or `max_wait_sec` passes, then return. Waiting costs nothing while the call is open, but every return costs a full model turn that re-reads your whole context. On 2026-10-09 two Staff sessions spent over half of all their tokens on waits that returned with nothing.

- Pass `next_cursor` from each `wait_for_events` result into the next call. The `cursor` from `register_agent` is your starting point.
- `timed_out: true` is normal. Call again.
- Leave `max_wait_sec` out. Staff waits up to 50 minutes (its context stays cached for an hour), everyone else 240 seconds (their cache lasts 5 minutes). Never pass a shorter value to check more often: events wake you at once.
- If a long command (a CI wait, a slow test) keeps a Senior busy, run it in steps under 4 minutes so your cache stays warm between steps.
- A Staff wait ends only for events Staff must act on (questions, reviews, deliveries, blockers, orphaned assignments, mentions, pokes, Client controls, Linear changes). Routine events (job status, progress, artifacts, claims, board messages) come back with the next waking event or the timeout. To get a Staff's attention, mention it.
- Staff sessions compact automatically at about 280k tokens. After a compaction, re-read what you need from `get_job` and `get_thread` instead of relying on memory: the board is the durable record.
- After a timed-out wait, call again right away. Do not write any text, summary or thinking about it first.
- An open wait counts as presence, so you stay on the active roster while you wait.
- Events are notifications. The durable record is in `get_job` and `get_thread`. When in doubt, read the record.
