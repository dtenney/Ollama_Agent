import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';
import { logInfo, logError } from './logger';

export interface MCPTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface MCPServer {
    name: string;
    client: Client;
    transport: StdioClientTransport;
    tools: MCPTool[];
}

const activeServers = new Map<string, MCPServer>();

/**
 * Start an MCP server and connect to it
 */
export async function startMCPServer(
    name: string,
    command: string,
    args: string[],
    env: Record<string, string> = {}
): Promise<MCPServer> {
    try {
        logInfo(`Starting MCP server: ${name} (${command} ${args.join(' ')})`);

        const transport = new StdioClientTransport({
            command,
            args,
            env: { ...process.env as Record<string, string>, ...env },
        });

        const client = new Client({
            name: `ollamapilot-${name}`,
            version: '1.0.0',
        }, {
            capabilities: {},
        });

        await client.connect(transport);
        logInfo(`MCP server ${name} connected`);

        // List available tools
        const toolsResult = await client.listTools();
        const tools = toolsResult.tools.map((tool: any) => ({
            name: tool.name,
            description: tool.description || '',
            inputSchema: tool.inputSchema || {},
        }));

        logInfo(`MCP server ${name} has ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);

        const server: MCPServer = { name, client, transport, tools };
        activeServers.set(name, server);
        return server;
    } catch (err) {
        logError(`Failed to start MCP server ${name}: ${(err as Error).message}`);
        throw err;
    }
}

/**
 * Call a tool on an MCP server
 */
export async function callMCPTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
): Promise<string> {
    const server = activeServers.get(serverName);
    if (!server) {
        throw new Error(`MCP server ${serverName} not found. Available: ${Array.from(activeServers.keys()).join(', ')}`);
    }

    try {
        logInfo(`Calling MCP tool: ${serverName}.${toolName} with args: ${JSON.stringify(args)}`);
        const result = await server.client.callTool({ name: toolName, arguments: args });
        
        // Extract text content from result
        let content = '';
        if (Array.isArray(result.content)) {
            for (const item of result.content) {
                if (item.type === 'text') {
                    content += item.text;
                }
            }
        }
        
        logInfo(`MCP tool ${serverName}.${toolName} returned ${content.length} chars`);
        return content;
    } catch (err) {
        const msg = (err as Error).message;
        logError(`MCP tool ${serverName}.${toolName} failed: ${msg}`);
        throw new Error(`MCP tool error: ${msg}`);
    }
}

/**
 * Get all available MCP tools from all connected servers
 */
export function getAllMCPTools(): Array<{ server: string; tool: MCPTool }> {
    const allTools: Array<{ server: string; tool: MCPTool }> = [];
    for (const [serverName, server] of activeServers.entries()) {
        for (const tool of server.tools) {
            allTools.push({ server: serverName, tool });
        }
    }
    return allTools;
}

/**
 * Convert MCP tools to Ollama tool format
 */
export function mcpToolsToOllamaFormat(): unknown[] {
    const ollamaTools: unknown[] = [];
    
    for (const { server, tool } of getAllMCPTools()) {
        ollamaTools.push({
            type: 'function',
            function: {
                name: `mcp_${server}_${tool.name}`,
                description: `[MCP ${server} - PREFERRED] ${tool.description || tool.name}`,
                parameters: tool.inputSchema,
            },
        });
    }
    
    return ollamaTools;
}

/**
 * Parse MCP tool name from Ollama format (mcp_servername_toolname)
 */
export function parseMCPToolName(name: string): { server: string; tool: string } | null {
    const match = name.match(/^mcp_([^_]+)_(.+)$/);
    if (!match) return null;
    return { server: match[1], tool: match[2] };
}

/**
 * Stop all MCP servers
 */
export async function stopAllMCPServers(): Promise<void> {
    for (const [name, server] of activeServers.entries()) {
        try {
            await server.client.close();
            logInfo(`Stopped MCP server: ${name}`);
        } catch (err) {
            logError(`Error stopping MCP server ${name}: ${(err as Error).message}`);
        }
    }
    activeServers.clear();
}

/**
 * Check if a tool name is an MCP tool
 */
export function isMCPTool(toolName: string): boolean {
    return toolName.startsWith('mcp_');
}
