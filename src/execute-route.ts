/**
 * Execute Route — CRESyncFlow MCP Bridge endpoints
 *
 * Exposes REST endpoints consumed by CRESyncFlow-v2's mcp-tools-bridge.ts:
 *   GET  /tools   — all tool definitions in Anthropic input_schema format
 *   POST /execute — execute a named tool by { name, arguments }
 *
 * Per-request GHL credentials (multi-tenant):
 *   Pass x-ghl-access-token + x-ghl-location-id headers to use a specific
 *   GHL account instead of the server's default env credentials.
 */

import type { Application } from 'express';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolRegistry } from './tool-registry.js';
import type { MCPAppsManager } from './apps/index.js';
import type { GHLConfig } from './types/ghl-types.js';
import { EnhancedGHLClient } from './enhanced-ghl-client.js';
import { ToolRegistry as ToolRegistryClass } from './tool-registry.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function toAnthropicTool(tool: Tool) {
  const schema: Record<string, unknown> =
    (tool as any).inputSchema ?? (tool as any).input_schema ?? {};

  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: {
      type: 'object' as const,
      properties: (schema.properties as Record<string, unknown>) ?? {},
      ...(Array.isArray(schema.required) ? { required: schema.required as string[] } : {}),
    },
  };
}

// ── Route Registration ────────────────────────────────────────────────────────

export function registerExecuteRoutes(
  app: Application,
  defaultRegistry: ToolRegistry,
  appsManager: MCPAppsManager,
  appTools: Tool[],
  baseConfig?: GHLConfig
): void {
  // ── GET /tools ────────────────────────────────────────────────────────────
  app.get('/tools', (_req, res) => {
    try {
      const allDefs = defaultRegistry.getAllToolDefinitions(appTools);
      const anthropicTools = allDefs.map(toAnthropicTool);
      res.json({ tools: anthropicTools, count: anthropicTools.length });
    } catch (err: any) {
      console.error('[execute-route] GET /tools error:', err.message);
      res.status(500).json({ error: 'Failed to list tools' });
    }
  });

  // ── POST /execute ─────────────────────────────────────────────────────────
  // Supports per-request GHL credentials via headers:
  //   x-ghl-access-token — user's GHL API key / OAuth token
  //   x-ghl-location-id  — user's GHL location/sub-account ID
  app.post('/execute', async (req, res) => {
    const body = req.body ?? {};
    const toolName: string | undefined = body.name;
    const toolArgs: Record<string, unknown> = body.arguments ?? {};

    if (!toolName || typeof toolName !== 'string') {
      res.status(400).json({ error: 'Body must include a non-empty string "name"' });
      return;
    }

    // Use per-request credentials if provided
    const perReqToken = req.headers['x-ghl-access-token'] as string | undefined;
    const perReqLoc   = req.headers['x-ghl-location-id']  as string | undefined;

    let registry = defaultRegistry;
    if (perReqToken && perReqLoc && baseConfig) {
      const perReqConfig: GHLConfig = {
        ...baseConfig,
        accessToken: perReqToken,
        locationId:  perReqLoc,
      };
      const perReqClient = new EnhancedGHLClient(perReqConfig);
      registry = new ToolRegistryClass(perReqClient) as unknown as ToolRegistry;
    }

    try {
      // 1. Try GHL registry tools
      const registryResult = await registry.callTool(toolName, toolArgs);
      if (registryResult !== undefined) {
        res.json({ result: registryResult });
        return;
      }

      // 2. MCP App tools (always default)
      if (appsManager.isAppTool(toolName)) {
        const appResult = await appsManager.executeTool(toolName, toolArgs);
        res.json({ result: appResult });
        return;
      }

      res.status(404).json({ error: `Unknown tool: ${toolName}` });
    } catch (err: any) {
      console.error(`[execute-route] POST /execute tool=${toolName} error:`, err.message);
      res.status(500).json({ error: `Tool execution failed: ${err.message}` });
    }
  });
}
