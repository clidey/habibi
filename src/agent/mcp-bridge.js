const path = require('path');
const { asHabibiToolName } = require('./harness-policy');

/** Local MCP discovery bridge. Server definitions live in ignored local state;
 * discovery never copies credentials or executes a tool. */
/** @param {{ root:string, fs:any }} options @returns {any} */
function createMcpBridge({ root, fs }) {
  const configFile = path.join(root, '.habibi', 'mcp-servers.json');
  const read = () => {
    try {
      const servers = JSON.parse(fs.readFileSync(configFile, 'utf8')).servers || [];
      return (Array.isArray(servers) ? servers : Object.entries(servers).map(([id, definition]) => ({ id, ...definition }))).filter((server) => server && typeof server.id === 'string' && (server.transport === 'stdio' || server.transport === 'http' || server.url));
    } catch (_) {
      return [];
    }
  };
  const list = () => read().map(({ id, name, transport }) => ({ id, name: name || id, transport }));
  // A scoped read session closes immediately after a workspace action. No idle
  // MCP process, polling loop, or browser-owned credentials are needed.
  const readSession = async (serverId, run) => {
    const definition = read().find((server) => server.id === serverId);
    if (!definition) throw new Error('MCP server is not configured.');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const transport = definition.transport === 'stdio'
      ? new (await import('@modelcontextprotocol/sdk/client/stdio.js')).StdioClientTransport({ command: definition.command, args: definition.args || [], env: definition.env })
      : new (await import('@modelcontextprotocol/sdk/client/streamableHttp.js')).StreamableHTTPClientTransport(new URL(definition.url), { requestInit: { headers: definition.headers || {} } });
    const client = new Client({ name: 'habibi', version: '0.1.0' });
    try {
      await client.connect(transport, { timeout: 20_000 });
      const tools = (await client.listTools()).tools || [];
      return await run({ tools, call: async (name, args) => {
        const tool = tools.find((item) => item.name === name);
        if (!tool || tool.annotations?.readOnlyHint !== true) throw new Error('Tool is not explicitly read-only.');
        return client.callTool({ name, arguments: args }, undefined, { timeout: 20_000 });
      } });
    } finally { await client.close().catch(() => {}); }
  };
  const discover = async (serverId) => {
    const definition = read().find((server) => server.id === serverId);
    if (!definition) return { ok: false, error: 'MCP server is not configured.', tools: [] };
    let client;
    try {
      const [{ Client }, transports] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        definition.transport === 'stdio'
          ? import('@modelcontextprotocol/sdk/client/stdio.js')
          : import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      ]);
      const transport =
        definition.transport === 'stdio'
          ? new transports.StdioClientTransport({
              command: definition.command,
              args: definition.args || [],
              env: definition.env,
            })
          : new transports.StreamableHTTPClientTransport(new URL(definition.url));
      client = new Client({ name: 'habibi', version: '0.1.0' });
      await client.connect(transport);
      const response = await client.listTools();
      return {
        ok: true,
        tools: (response.tools || []).map((tool) => ({
          id: asHabibiToolName(definition.id, tool.name),
          serverId: definition.id,
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema,
          annotations: tool.annotations || {},
        })),
      };
    } catch (error) {
      return {
        ok: false,
        error: error.message || 'Could not connect to the MCP server.',
        tools: [],
      };
    } finally {
      await client?.close?.().catch(() => {});
    }
  };
  return { list, discover, readSession };
}

module.exports = { createMcpBridge };
