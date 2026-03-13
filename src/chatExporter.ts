import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logError } from './logger';

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: number;
}

export class ChatExporter {
    /**
     * Export chat history to markdown format
     */
    static async exportToMarkdown(
        messages: ChatMessage[],
        sessionTitle: string = 'Chat Session'
    ): Promise<void> {
        try {
            const markdown = this.generateMarkdown(messages, sessionTitle);
            
            // Show save dialog
            const defaultFilename = this.sanitizeFilename(sessionTitle);
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`${defaultFilename}.md`),
                filters: { 'Markdown': ['md'], 'All Files': ['*'] }
            });

            if (!uri) {
                return; // User cancelled
            }

            // Write file
            await fs.promises.writeFile(uri.fsPath, markdown, 'utf8');
            
            logInfo(`[export] Chat exported to ${uri.fsPath}`);
            
            // Ask if user wants to open the file
            const action = await vscode.window.showInformationMessage(
                'Chat exported successfully',
                'Open File'
            );
            
            if (action === 'Open File') {
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logError(`[export] Failed to export chat: ${msg}`);
            vscode.window.showErrorMessage(`Failed to export chat: ${msg}`);
        }
    }

    /**
     * Generate markdown content from chat messages
     */
    private static generateMarkdown(messages: ChatMessage[], title: string): string {
        const timestamp = new Date().toISOString().split('T')[0];
        let markdown = `# ${title}\n\n`;
        markdown += `**Exported:** ${timestamp}\n\n`;
        markdown += `---\n\n`;

        for (const msg of messages) {
            if (msg.role === 'system') {
                continue; // Skip system messages
            }

            const roleLabel = msg.role === 'user' ? '👤 User' : '🤖 Assistant';
            const timeStr = msg.timestamp 
                ? new Date(msg.timestamp).toLocaleTimeString()
                : '';

            markdown += `## ${roleLabel}`;
            if (timeStr) {
                markdown += ` *(${timeStr})*`;
            }
            markdown += `\n\n`;

            // Clean and format content
            const content = this.formatContent(msg.content);
            markdown += `${content}\n\n`;
            markdown += `---\n\n`;
        }

        return markdown;
    }

    /**
     * Format message content for markdown
     */
    private static formatContent(content: string): string {
        // Content is already in markdown format from the chat
        // Just ensure proper spacing
        return content.trim();
    }

    /**
     * Sanitize filename by removing invalid characters
     */
    private static sanitizeFilename(name: string): string {
        return name
            .replace(/[<>:"/\\|?*]/g, '-')
            .replace(/\s+/g, '_')
            .substring(0, 100); // Limit length
    }

    /**
     * Export to JSON format (alternative format)
     */
    static async exportToJSON(
        messages: ChatMessage[],
        sessionTitle: string = 'Chat Session'
    ): Promise<void> {
        try {
            const data = {
                title: sessionTitle,
                exportedAt: new Date().toISOString(),
                messages: messages.map(m => ({
                    role: m.role,
                    content: m.content,
                    timestamp: m.timestamp
                }))
            };

            const defaultFilename = this.sanitizeFilename(sessionTitle);
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`${defaultFilename}.json`),
                filters: { 'JSON': ['json'], 'All Files': ['*'] }
            });

            if (!uri) {
                return;
            }

            await fs.promises.writeFile(
                uri.fsPath,
                JSON.stringify(data, null, 2),
                'utf8'
            );

            logInfo(`[export] Chat exported to ${uri.fsPath}`);
            vscode.window.showInformationMessage('Chat exported successfully');
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logError(`[export] Failed to export chat: ${msg}`);
            vscode.window.showErrorMessage(`Failed to export chat: ${msg}`);
        }
    }
}
