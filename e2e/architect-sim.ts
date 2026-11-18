import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BASE } from './fixtures.ts';

/** The stub Architect: an MCP client of /architect/mcp with the token of the initiative's chat. */
export class ArchitectSim {
  private readonly client: Client;
  private constructor(client: Client) {
    this.client = client;
  }
  static async connect(token: string): Promise<ArchitectSim> {
    const client = new Client({ name: 'e2e-architect', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/architect/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return new ArchitectSim(client);
  }
  /** The tool's result, or a thrown error with the server's message when the tool refuses. */
  async call(name: string, args: Record<string, unknown>): Promise<any> {
    const res = (await this.client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = res.content[0]!.text;
    if (res.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text).result;
  }
}
