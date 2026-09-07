import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const destination = process.env.WHITEFRAME_MCP_AUDIT_OUT;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

if (destination) {
  const record = (entry) =>
    appendFileSync(
      destination,
      `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...entry })}\n`,
    );
  const listTools = Client.prototype.listTools;
  const callTool = Client.prototype.callTool;

  Client.prototype.listTools = async function (...args) {
    const result = await listTools.apply(this, args);
    record({
      kind: 'catalog',
      tools: result.tools.map((tool) => ({ name: tool.name, schemaHash: digest(tool.inputSchema) })),
    });
    return result;
  };

  Client.prototype.callTool = async function (...args) {
    const request = args[0];
    const entry = {
      kind: 'call',
      name: request.name,
      argumentsHash: digest(request.arguments ?? {}),
      commands:
        request.name === 'edit_batch'
          ? request.arguments?.commands?.map((command) => command.type)
          : undefined,
    };
    try {
      const result = await callTool.apply(this, args);
      record({ ...entry, success: !result.isError, responseHash: digest(result) });
      return result;
    } catch (error) {
      record({ ...entry, success: false, transportError: error.name });
      throw error;
    }
  };
}
