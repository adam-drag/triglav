import { z } from 'zod';

/**
 * The Architect's exceptions: the few things it may do that no other agent does. Each rule is one entry here, and this
 * list is the only place a rule is written:
 * - `guide` is its paragraph on the Architect's card (src/guide/architect.md, at RULES_MARKER),
 * - `wake` is the line a blocker wake adds, so the Architect reaches for the rule when a blocker asks for it,
 * - `tool` is the MCP tool it uses. src/architect.ts maps each tool name to its handler in RULE_HANDLERS, whose type
 *   refuses a rule without one.
 *
 * Imports only zod: scripts/operator.ts reads it to build the card on the host.
 *
 * To add a rule: add an entry here, add its handler to RULE_HANDLERS in src/architect.ts, and test the handler.
 */

export type ArchitectRule = {
  id: string;
  title: string;
  guide: string;
  wake: string;
  tool: { name: string; description: string; input: z.ZodRawShape; idempotent: boolean; openWorld: boolean };
};

export const RELEASE_NOTES_MAX = 4000;

export const ARCHITECT_RULES = [
  {
    id: 'mark_pr_ready',
    title: 'Marking a PR ready',
    guide:
      "Call `mark_pr_ready` with the `job_id`. Triglav takes the PR from the job's latest review package, which exists only after the local review gate passed, and refuses a PR outside the card's repository. Do it when a blocker on a job of your initiative asks for it (pass its `blocker_id`: it is resolved once the PR is ready), or when a draft PR holds up CI or the Copilot loop and the job has a review package. Triglav tells you the outcome; then say it in one line in the room. This does not cover merging, closing a PR or turning it back into a draft.",
    wake: 'A client decision that asks for a PR to be marked ready: call mark_pr_ready with its job_id and blocker_id.',
    tool: {
      name: 'mark_pr_ready',
      description:
        "Mark the draft PR of a job of your initiative ready for review (gh pr ready). Only you may do this; no other agent does. The PR is the one in the job's latest review package, which exists only after the local review gate passed, and it must be in the card's repository. Refused otherwise, and for a done or cancelled job. Pass blocker_id when a blocker on that job asks for it: it is resolved once the PR is ready. The runner runs it, and Triglav tells you the outcome: then say it in one line in the room. It never merges and never turns a PR back into a draft.",
      input: {
        job_id: z.string().min(1).max(64),
        blocker_id: z.string().max(64).optional().describe('An open blocker of the same job that asks for the PR to be marked ready.'),
      },
      idempotent: true,
      openWorld: true,
    },
  },
  {
    id: 'release_notes',
    title: 'Release notes',
    guide:
      "A Senior or Staff may ask for the `## Release notes` (and `## Feature flags`) block of a PR to be confirmed, in a client decision blocker. Answer it with `answer_release_notes`: `approve` when the block is right, or `suggest` with the corrected block in `text`. Check it against the design and the card: the Type (feature, improvement, fix or internal), a headline in the user's words, no ticket codes, no benefit the change does not deliver, and the exact flag key and rollout. Your answer is posted on the job's General thread and resolves the blocker, so the PR goes on without the Client. Escalate instead when the block depends on a product choice the design does not settle, such as whether to announce a feature at all.",
    wake: 'A client decision that asks to confirm release notes: approve them or suggest a corrected block with answer_release_notes.',
    tool: {
      name: 'answer_release_notes',
      description:
        'Answer a client decision blocker of your initiative that asks for the release notes of a PR to be confirmed. approve: use the block as written. suggest: use the block in text instead. Posted on the job\'s General thread as you, and the blocker is resolved. Refused for a blocker that is not an open client decision of a job of your initiative. No citation is needed: this is your call by rule.',
      input: {
        blocker_id: z.string().min(1).max(64),
        verdict: z.enum(['approve', 'suggest']),
        text: z.string().max(RELEASE_NOTES_MAX).optional().describe(`suggest only: the corrected block, at most ${RELEASE_NOTES_MAX} characters, ready to paste into the PR body.`),
        note: z.string().max(500).optional().describe('One sentence on why, shown above the block.'),
      },
      idempotent: false,
      openWorld: false,
    },
  },
] as const satisfies readonly ArchitectRule[];

export type RuleTool = (typeof ARCHITECT_RULES)[number]['tool']['name'];

/** Where the rules go on the card. The card keeps the marker on its own line. */
export const RULES_MARKER = '<!-- architect-rules -->';

/** The card with each rule's paragraph in place of the marker. A card without the marker gets them at the end. */
export function withRules(card: string): string {
  const section = ARCHITECT_RULES.map((r) => `**${r.title}.** ${r.guide}`).join('\n\n');
  return card.includes(RULES_MARKER) ? card.replace(RULES_MARKER, section) : `${card.trim()}\n\n${section}`;
}

/** The rule lines of a blocker wake. */
export function rulesWake(): string {
  return ARCHITECT_RULES.map((r) => r.wake).join(' ');
}
