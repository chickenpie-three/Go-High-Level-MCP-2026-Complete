/**
 * Vercel Serverless Function — Full GHL MCP Server (563 tools)
 *
 * Multi-tenant: pass x-ghl-access-token and x-ghl-location-id headers per request.
 * Falls back to GHL_API_KEY / GHL_LOCATION_ID env vars if headers absent.
 */

const express = require('express');
const cors = require('cors');

let EnhancedGHLClient, ToolRegistry, Server, StreamableHTTPServerTransport, CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError;
let loadError = null;

try {
  ({ EnhancedGHLClient } = require('../dist/enhanced-ghl-client.js'));
  ({ ToolRegistry } = require('../dist/tool-registry.js'));
  ({ Server } = require('@modelcontextprotocol/sdk/server/index.js'));
  ({ StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js'));
  ({ CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } = require('@modelcontextprotocol/sdk/types.js'));
} catch (err) {
  loadError = err.message + ' | ' + err.stack?.split('\n').slice(0, 3).join(' ');
}

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'mcp-session-id', 'x-ghl-access-token', 'x-ghl-location-id'],
}));
app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/', (_req, res) => {
  res.json({
    status: loadError ? 'error' : 'healthy',
    server: 'ghl-mcp-server',
    version: '2.0.0-vercel',
    protocol: '2024-11-05',
    transport: 'Streamable HTTP at /mcp',
    multiTenant: true,
    loadError: loadError || undefined,
    modulesLoaded: !loadError,
  });
});

function createMCPServer(ghlClient) {
  const server = new Server(
    { name: 'ghl-mcp-server', version: '2.0.0' },
    { capabilities: { tools: {} } },
  );

  const registry = new ToolRegistry(ghlClient);
  const tools = registry.getTools();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
    }
    try {
      const result = await tool.execute(args || {});
      return {
        content: Array.isArray(result?.content)
          ? result.content
          : [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// MCP endpoint — Streamable HTTP
app.all('/mcp', async (req, res) => {
  if (loadError) {
    return res.status(500).json({ error: 'Module load failed', details: loadError });
  }
  try {
    const accessToken = req.headers['x-ghl-access-token']
      || (req.headers['authorization'] || '').replace('Bearer ', '')
      || process.env.GHL_API_KEY
      || '';
    const locationId = req.headers['x-ghl-location-id']
      || process.env.GHL_LOCATION_ID
      || '';

    if (!accessToken) {
      return res.status(401).json({
        error: 'Missing GHL credentials. Pass x-ghl-access-token header.',
      });
    }

    const ghlClient = new EnhancedGHLClient({
      accessToken,
      baseUrl: process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com',
      version: '2021-07-28',
      locationId,
    });

    const server = createMCPServer(ghlClient);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on('close', () => { server.close().catch(() => {}); });
  } catch (err) {
    console.error('MCP error:', err.message, err.stack);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: err.message,
        stack: err.stack?.split('\n').slice(0, 5),
      });
    }
  }
});

module.exports = app;
