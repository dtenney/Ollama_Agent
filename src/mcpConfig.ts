import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logInfo, logError } from './logger';

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
                logError(`Failed to load MCP config from ${configPath}: ${(err as Error).message}`);
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
        servers: [
            {
                name: 'filesystem',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem', workspaceRoot],
                env: {},
            },
            {
                name: 'sequential-thinking',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
                env: {},
            },
        ],
    };
    
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(exampleConfig, null, 2), 'utf8');
    
    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc);
    
    vscode.window.showInformationMessage('Created example MCP config. Restart extension to apply.');
}
