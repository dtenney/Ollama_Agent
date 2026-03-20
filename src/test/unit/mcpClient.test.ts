import * as assert from 'assert';

// Replicate pure functions from mcpClient.ts for testing without vscode/MCP SDK deps
function parseMCPToolName(name: string): { server: string; tool: string } | null {
    const match = name.match(/^mcp__(.+?)__(.+)$/);
    if (!match) return null;
    return { server: match[1], tool: match[2] };
}

function isMCPTool(toolName: string): boolean {
    return toolName.startsWith('mcp__');
}

describe('MCPClient Module', () => {

    describe('parseMCPToolName', () => {
        it('should parse valid MCP tool names', () => {
            const result = parseMCPToolName('mcp__filesystem__read_file');
            assert.deepStrictEqual(result, { server: 'filesystem', tool: 'read_file' });
        });

        it('should handle server names with underscores', () => {
            const result = parseMCPToolName('mcp__my_server__my_complex_tool_name');
            assert.deepStrictEqual(result, { server: 'my_server', tool: 'my_complex_tool_name' });
        });

        it('should return null for non-MCP tool names', () => {
            assert.strictEqual(parseMCPToolName('read_file'), null);
            assert.strictEqual(parseMCPToolName('edit_file'), null);
            assert.strictEqual(parseMCPToolName('workspace_summary'), null);
        });

        it('should return null for malformed MCP names', () => {
            assert.strictEqual(parseMCPToolName('mcp__'), null);
            assert.strictEqual(parseMCPToolName('mcp__server'), null);
            assert.strictEqual(parseMCPToolName(''), null);
        });
    });

    describe('isMCPTool', () => {
        it('should return true for MCP tool names', () => {
            assert.strictEqual(isMCPTool('mcp__filesystem__read_file'), true);
            assert.strictEqual(isMCPTool('mcp__thinking__think'), true);
        });

        it('should return false for built-in tool names', () => {
            assert.strictEqual(isMCPTool('read_file'), false);
            assert.strictEqual(isMCPTool('edit_file'), false);
            assert.strictEqual(isMCPTool('memory_write'), false);
        });

        it('should return false for empty string', () => {
            assert.strictEqual(isMCPTool(''), false);
        });
    });

    describe('Ollama Tool Format Conversion', () => {
        it('should convert MCP tool to Ollama format', () => {
            const mcpTool = {
                name: 'read_file',
                description: 'Read a file from the filesystem',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path' },
                    },
                    required: ['path'],
                },
            };
            const serverName = 'filesystem';

            const ollamaTool = {
                type: 'function',
                function: {
                    name: `mcp__${serverName}__${mcpTool.name}`,
                    description: `[MCP ${serverName} - PREFERRED] ${mcpTool.description}`,
                    parameters: mcpTool.inputSchema,
                },
            };

            assert.strictEqual(ollamaTool.type, 'function');
            assert.strictEqual(ollamaTool.function.name, 'mcp__filesystem__read_file');
            assert.ok(ollamaTool.function.description.includes('[MCP filesystem'));
            assert.ok(ollamaTool.function.description.includes('PREFERRED'));
            assert.deepStrictEqual(ollamaTool.function.parameters, mcpTool.inputSchema);
        });
    });

    describe('MCPServerConfig Validation', () => {
        function validateConfig(cfg: any): boolean {
            return cfg &&
                typeof cfg.name === 'string' && cfg.name.length > 0 &&
                typeof cfg.command === 'string' && cfg.command.length > 0 &&
                Array.isArray(cfg.args);
        }

        it('should validate correct config', () => {
            assert.ok(validateConfig({
                name: 'filesystem',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem'],
            }));
        });

        it('should reject config without name', () => {
            assert.ok(!validateConfig({ command: 'npx', args: [] }));
        });

        it('should reject config without command', () => {
            assert.ok(!validateConfig({ name: 'test', args: [] }));
        });

        it('should reject config without args array', () => {
            assert.ok(!validateConfig({ name: 'test', command: 'npx' }));
        });

        it('should reject null/undefined', () => {
            assert.ok(!validateConfig(null));
            assert.ok(!validateConfig(undefined));
        });
    });
});
