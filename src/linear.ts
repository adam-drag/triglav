import { z } from 'zod';
import { AppError } from './lib.ts';

export const linearIssueSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  url: z.string().min(1),
  state: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
});

export const linearTreeSchema = linearIssueSchema.extend({
  children: z.array(linearIssueSchema).default([]),
});

export type LinearIssue = z.infer<typeof linearIssueSchema>;
export type LinearTree = z.infer<typeof linearTreeSchema>;

export interface LinearSource {
  /** Fetches an issue by UUID or identifier (for example ENG-123) with its direct sub-issues. */
  fetchTree(idOrIdentifier: string): Promise<LinearTree>;
}

const ISSUE_FIELDS = `id identifier title description url updatedAt state { name }`;

const TREE_QUERY = `query Tree($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} children(first: 100) { nodes { ${ISSUE_FIELDS} } } }
}`;

type RawIssue = Omit<LinearIssue, 'state'> & { state: { name: string } | null };

function fromRaw(raw: RawIssue): LinearIssue {
  return { ...raw, state: raw.state?.name ?? null };
}

/** Reads Linear through its GraphQL API with a personal API key. The orchestrator never writes to Linear. */
export class LinearGraphql implements LinearSource {
  private readonly apiKey: string;
  private readonly endpoint: string;

  constructor(apiKey: string, endpoint = 'https://api.linear.app/graphql') {
    this.apiKey = apiKey;
    this.endpoint = endpoint;
  }

  async fetchTree(idOrIdentifier: string): Promise<LinearTree> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: this.apiKey },
        body: JSON.stringify({ query: TREE_QUERY, variables: { id: idOrIdentifier } }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new AppError('linear_unavailable', `Linear could not be reached, try again later: ${(error as Error).message}`, 503);
    }
    if (!response.ok) {
      throw new AppError('linear_unavailable', `Linear returned HTTP ${response.status}, try again later`, 503);
    }
    const body = (await response.json()) as {
      data?: { issue: RawIssue & { children: { nodes: RawIssue[] } } };
      errors?: { message: string }[];
    };
    if (body.errors?.length || !body.data?.issue) {
      throw new AppError('linear_not_found', `Linear issue ${idOrIdentifier} not found: ${body.errors?.[0]?.message ?? 'no data'}`, 404);
    }
    const { children, ...issue } = body.data.issue;
    return { ...fromRaw(issue), children: children.nodes.map(fromRaw) };
  }
}
