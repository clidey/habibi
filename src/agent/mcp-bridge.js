const path = require('path');
const { asHabibiToolName } = require('./harness-policy');

/** Local MCP discovery bridge. Server definitions live in ignored local state;
 * discovery never copies credentials or executes a tool. */
/** @param {{ root:string, fs:any }} options @returns {any} */
function createMcpBridge({ root, fs }) {
  const configFile = path.join(root, '.habibi', 'mcp-servers.json');
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(configFile, 'utf8')).servers || [];
    } catch (_) {
      return [];
    }
  };
  const list = () => read().map(({ id, name, transport }) => ({ id, name: name || id, transport }));
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
  return { list, discover };
}

module.exports = { createMcpBridge };
