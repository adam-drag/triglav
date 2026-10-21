/**
 * A review prompt with the lessons of Copilot's later findings, for the evaluation harness only. Production keeps
 * `buildReviewPrompt` unchanged and no production caller imports this file. The harness `run` command picks a prompt per arm
 * (`--prompt learned`).
 *
 * It is the production prompt with one block of checks added to the end of "How to review". Each check answers a class of
 * defect that Copilot reported on a change the panel had already passed. The source, the classes and what is not known are
 * in DECISIONS.md ("The learned prompt"). The block is generic on purpose: it names no repository, library, ticket or
 * Copilot text, since fixtures and prompts here must not hold any of them. A lens seat keeps its lens section after the
 * block, so its "report only findings in this area" still wins.
 *
 * Not validated. Nothing has run this prompt. Tune it on the dev fixtures only and run the held-out ones once on a frozen
 * candidate (DECISIONS.md, "Fixture split"). A paid run needs the Client's budget.
 */
import { buildReviewPrompt } from '../../src/code-review.ts';

type PromptInput = Parameters<typeof buildReviewPrompt>[0];

/** The line of the production prompt that ends the steps. The block goes in front of it, so a lens section (which follows that line) comes after the block. */
const STEPS_END = '\n\nDo not report problems the diff did not touch or cause';

export const LEARNED_CHECKS = `Beyond steps 1 to 7, these checks cover gaps that later reviews found in changes this panel had already passed. Apply a check only when the diff touches that kind of code. A finding still needs a concrete failure path.

- **Enumerate, do not sample.** For code that parses, validates, splits, measures, compares or matches (paths, globs, YAML or JSON fields, command-line flags, limits, sizes), list the classes of input and trace each one through the lines you read: absent versus empty string or zero, one or two items, duplicates, cycles and self-references, a typo or unknown name that is dropped silently, two inputs that disagree (different runs, versions or owners), quotes and escapes, characters outside the basic plane, CRLF, comments, nesting, absolute versus relative paths, a value exactly at a cap. One bad shape is rarely the only one: go through all the classes, then report them as one finding with every shape.
- **Review the fix too.** In a later round, read every line the fix added against the same classes, and search for the same defect at other sites. A fix that covers the reported case but not its neighbours, or that adds a new edge case of its own, is the usual next finding.
- **Do not assume what a library, tool or platform does.** When correctness depends on its behaviour (configuration inherited from a base file, the shape of an error object, whether a read returns all the bytes, which resource types a service supports, what a serializer does with NaN, which version is installed), read its source, types or docs in the checkout when they are there. If you cannot confirm it, say in the finding that it is an assumption, and give it P2 at most.
- **Every path to the same guarantee.** When the change states or relies on a guarantee (no secrets in a subprocess environment, loopback only, fail closed, dev-only data, owner-only access, a platform guard), list every path that can reach the same resource and check each one: setup steps, subprocesses, merged or inherited configuration, defaults, overrides, client-side tools, other users of a shared helper. For an id, key or URL that a client supplies and the server then reads, signs or acts on, find where ownership is checked. For a value that must come from a fixed set, check that other values are refused.
- **One decision in two places.** When a value is decided in one place from stored data and in another place by a richer rule, or when a shared function gets a new consumer, check the new consumer against what the function assumes: lists copied from another runtime, a guard written for one platform, a type read from a field that other code overrides.
- **Every exit after an open.** After code opens, acquires, starts or reserves something, check every way out of the block, including an exception of a type the handler does not name and the exits of the code that runs before the handler.
- **Rules one by one.** Take the rules of step 3 that apply to the kind of code you read (error reporting, promise handling, empty and falsy values, test conventions, a lint or type rule the rules name) and check each against the diff on its own. Read a lint or type rule's configuration when you cannot run it. A rule you only skim is a rule you miss.
- **Tests and documents.** A test must be able to reach the scenario in its name: check that the order, timing or mock shape it builds makes that outcome possible, and that a mock has the shape the real caller gets. When a new case is tested through one entry point, check the sibling entry points. In a document, find the source of each factual claim (a line of code, a table in the same file, a tool's output), check every number and range against the document's own tables, treat "already done" as a claim that needs evidence, and apply any rule the document states about itself to all its claims.`;

/** The production prompt with `LEARNED_CHECKS` added to the end of "How to review". */
export function learnedReviewPrompt(o: PromptInput): string {
  const full = buildReviewPrompt(o);
  const at = full.indexOf(STEPS_END);
  if (at < 0) throw new Error('the production review prompt has no line that ends the steps: the learned prompt cannot add its checks');
  return `${full.slice(0, at)}\n\n${LEARNED_CHECKS}${full.slice(at)}`;
}
