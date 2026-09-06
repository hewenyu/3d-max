import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const apiUrl = process.env.WHITEFRAME_API_URL || `http://127.0.0.1:${process.env.PORT || 4173}`;
const parsed = new URL(apiUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.protocol !== 'http:')
  throw new Error('WHITEFRAME_API_URL must be a local HTTP URL');
let token = process.env.WHITEFRAME_MCP_TOKEN;
if (!token) {
  const response = await fetch(new URL('/api/connection', apiUrl));
  if (!response.ok) throw new Error('Could not connect to Whiteframe. Start the web server first.');
  token = ((await response.json()) as { token: string }).token;
}
const client = new Client({ name: 'whiteframe-stdio-bridge', version: '0.1.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('/mcp', apiUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);
const server = new Server(
  { name: 'whiteframe-studio', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'This stdio connection controls the running Whiteframe web editor. State and history are stored by the HTTP server in SQLite.',
  },
);
server.setRequestHandler(ListToolsRequestSchema, async (request) => client.listTools(request.params));
server.setRequestHandler(CallToolRequestSchema, async (request) => client.callTool(request.params));
await server.connect(new StdioServerTransport());
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await client.close();
  await server.close();
}
process.stdin.on('end', () => {
  void close();
});
process.on('SIGINT', () => {
  void close();
});
process.on('SIGTERM', () => {
  void close();
});
