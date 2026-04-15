import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logInfo, logError, toErrorMessage } from './logger';

export interface MCPServerConfig {
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
}

/**
 * Validate that a config object has all required fields
 */
function validateConfig(cfg: any): cfg is MCPServerConfig {
    return cfg && 
           typeof cfg.name === 'string' && cfg.name.length > 0 &&
           typeof cfg.command === 'string' && cfg.command.length > 0 &&
           Array.isArray(cfg.args);
}

/**
 * Load MCP server configurations from workspace settings or config file
 */
export function loadMCPConfig(): MCPServerConfig[] {
    const config = vscode.workspace.getConfiguration('ollamaAgent');
    const mcpServers = config.get<MCPServerConfig[]>('mcpServers', []);
    
    // Validate configs from settings
    const validFromSettings = mcpServers.filter(cfg => {
        if (!validateConfig(cfg)) {
            logError(`Invalid MCP config in settings: ${JSON.stringify(cfg)}`);
            return false;
        }
        return true;
    });
    
    if (validFromSettings.length > 0) {
        logInfo(`Loaded ${validFromSettings.length} MCP server(s) from settings`);
        return validFromSettings;
    }
    
    // Try loading from .ollamapilot/mcp.json in workspace root
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
        const configPath = path.join(workspaceRoot, '.ollamapilot', 'mcp.json');
        if (fs.existsSync(configPath)) {
            try {
                const content = fs.readFileSync(configPath, 'utf8');
                const parsed = JSON.parse(content) as { servers: MCPServerConfig[] };
                
                // Validate configs from file
                const validFromFile = (parsed.servers || []).filter(cfg => {
                    if (!validateConfig(cfg)) {
                        logError(`Invalid MCP config in ${configPath}: ${JSON.stringify(cfg)}`);
                        return false;
                    }
                    return true;
                });
                
                if (validFromFile.length > 0) {
                    logInfo(`Loaded ${validFromFile.length} MCP server(s) from ${configPath}`);
                    return validFromFile;
                }
            } catch (err) {
                logError(`Failed to load MCP config from ${configPath}: ${toErrorMessage(err)}`);
            }
        }
    }
    
    // Return default filesystem server if nothing configured
    return getDefaultMCPServers(workspaceRoot);
}

/**
 * Get default MCP servers (filesystem only)
 */
function getDefaultMCPServers(workspaceRoot?: string): MCPServerConfig[] {
    if (!workspaceRoot) return [];
    
    return [
        {
            name: 'filesystem',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', workspaceRoot],
            env: {},
        },
    ];
}

/**
 * Create example MCP config file in workspace
 */
export async function createExampleMCPConfig(): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }
    
    const configDir = path.join(workspaceRoot, '.ollamapilot');
    const configPath = path.join(configDir, 'mcp.json');
    
    if (fs.existsSync(configPath)) {
        const overwrite = await vscode.window.showWarningMessage(
            'MCP config already exists. Overwrite?',
            'Yes', 'No'
        );
        if (overwrite !== 'Yes') return;
    }
    
    const exampleConfig = {
        "_comment": "OllamaPilot MCP server configuration. Enable servers by uncommenting and configuring them. Run 'npm install -g <package>' for any server you enable.",
        servers: [
            // ── Always-on: local filesystem access ────────────────────────
            {
                name: 'filesystem',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem', workspaceRoot],
                env: {},
            },
            // ── Date/time awareness ───────────────────────────────────────
            // Gives the agent: current date, time, timezone, date arithmetic.
            // Install: npm install -g @modelcontextprotocol/server-time
            {
                name: 'time',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-time'],
                env: {},
            },
            // ── Web fetch + search ────────────────────────────────────────
            // Gives the agent: fetch_url, web_search (uses Brave Search API).
            // Install: npm install -g @modelcontextprotocol/server-brave-search
            // Required env: BRAVE_API_KEY (get free key at https://api.search.brave.com)
            // {
            //     name: 'brave-search',
            //     command: 'npx',
            //     args: ['-y', '@modelcontextprotocol/server-brave-search'],
            //     env: { BRAVE_API_KEY: 'YOUR_KEY_HERE' },
            // },
            // ── URL fetch (no search key needed) ─────────────────────────
            // Gives the agent: fetch(url) — reads web pages as markdown.
            // Install: npm install -g @modelcontextprotocol/server-fetch
            // {
            //     name: 'fetch',
            //     command: 'npx',
            //     args: ['-y', '@modelcontextprotocol/server-fetch'],
            //     env: {},
            // },
            // ── PostgreSQL ────────────────────────────────────────────────
            // Gives the agent: query, list_tables, describe_table.
            // Install: npm install -g @modelcontextprotocol/server-postgres
            // {
            //     name: 'postgres',
            //     command: 'npx',
            //     args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://user:pass@localhost:5432/dbname'],
            //     env: {},
            // },
            // ── PDF / document reading ────────────────────────────────────
            // Gives the agent: read_pdf, extract_text from local PDF files.
            // Install: pip install mcp-server-pdf  (Python-based)
            // {
            //     name: 'pdf',
            //     command: 'python',
            //     args: ['-m', 'mcp_server_pdf'],
            //     env: {},
            // },
            // ── Git ───────────────────────────────────────────────────────
            // Gives the agent: git_log, git_diff, git_blame, git_show.
            // Install: npm install -g @modelcontextprotocol/server-git
            // {
            //     name: 'git',
            //     command: 'npx',
            //     args: ['-y', '@modelcontextprotocol/server-git', '--repository', workspaceRoot],
            //     env: {},
            // },
            // ── Sequential thinking ───────────────────────────────────────
            // Gives the agent a structured multi-step reasoning tool.
            // {
            //     name: 'sequential-thinking',
            //     command: 'npx',
            //     args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
            //     env: {},
            // },
        ],
    };
    
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(exampleConfig, null, 2), 'utf8');
    
    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc);
    
    vscode.window.showInformationMessage('Created example MCP config. Restart extension to apply.');
}
