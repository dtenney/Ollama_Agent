import * as vscode from 'vscode';

// ── Template definition ───────────────────────────────────────────────────────

export interface PromptTemplate {
    name: string;
    prompt: string;
    variables: string[];
    builtin?: boolean;
}

// ── Built-in templates ────────────────────────────────────────────────────────

export const BUILTIN_TEMPLATES: PromptTemplate[] = [
    {
        name: 'Add Tests',
        prompt: 'Generate comprehensive unit tests for this {language} code:\n\n{selection}',
        variables: ['language', 'selection'],
        builtin: true
    },
    {
        name: 'Add JSDoc',
        prompt: 'Add JSDoc/docstring comments to this function:\n\n{selection}',
        variables: ['selection'],
        builtin: true
    },
    {
        name: 'Explain Error',
        prompt: 'Explain this error and suggest a fix:\n\n{error}',
        variables: ['error'],
        builtin: true
    },
    {
        name: 'Refactor',
        prompt: 'Refactor this {language} code to improve readability and maintainability:\n\n{selection}',
        variables: ['language', 'selection'],
        builtin: true
    },
    {
        name: 'Add Type Hints',
        prompt: 'Add type hints/annotations to this {language} code:\n\n{selection}',
        variables: ['language', 'selection'],
        builtin: true
    },
    {
        name: 'Optimize Performance',
        prompt: 'Analyze and optimize the performance of this {language} code:\n\n{selection}',
        variables: ['language', 'selection'],
        builtin: true
    }
];

// ── Template manager ──────────────────────────────────────────────────────────

export class TemplateManager {
    constructor(private readonly context: vscode.ExtensionContext) {}

    /** Get all templates (built-in + custom). */
    getAll(): PromptTemplate[] {
        const custom = this.context.workspaceState.get<PromptTemplate[]>('ollamaAgent.customTemplates', []);
        return [...BUILTIN_TEMPLATES, ...custom];
    }

    /** Get custom templates only. */
    getCustom(): PromptTemplate[] {
        return this.context.workspaceState.get<PromptTemplate[]>('ollamaAgent.customTemplates', []);
    }

    /** Save a custom template. */
    async save(template: PromptTemplate): Promise<void> {
        const custom = this.getCustom();
        const existing = custom.findIndex(t => t.name === template.name);
        if (existing >= 0) {
            custom[existing] = template;
        } else {
            custom.push(template);
        }
        await this.context.workspaceState.update('ollamaAgent.customTemplates', custom);
    }

    /** Delete a custom template by name. */
    async delete(name: string): Promise<void> {
        const custom = this.getCustom().filter(t => t.name !== name);
        await this.context.workspaceState.update('ollamaAgent.customTemplates', custom);
    }

    /** Extract variables from a prompt string. */
    static extractVariables(prompt: string): string[] {
        const matches = prompt.match(/\{(\w+)\}/g);
        if (!matches) return [];
        return [...new Set(matches.map(m => m.slice(1, -1)))];
    }

    /** Substitute variables in a template prompt. */
    static substitute(prompt: string, values: Record<string, string>): string {
        let result = prompt;
        for (const [key, value] of Object.entries(values)) {
            result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
        }
        return result;
    }
}

// ── Manage templates UI ───────────────────────────────────────────────────────

export async function showManageTemplatesUI(manager: TemplateManager): Promise<void> {
    const custom = manager.getCustom();
    
    const action = await vscode.window.showQuickPick(
        [
            { label: '$(add) Create New Template', action: 'create' },
            ...(custom.length > 0 ? [{ label: '$(edit) Edit Template', action: 'edit' }] : []),
            ...(custom.length > 0 ? [{ label: '$(trash) Delete Template', action: 'delete' }] : [])
        ],
        { placeHolder: 'Manage Prompt Templates' }
    );

    if (!action) return;

    switch (action.action) {
        case 'create':
            await createTemplate(manager);
            break;
        case 'edit':
            await editTemplate(manager);
            break;
        case 'delete':
            await deleteTemplate(manager);
            break;
    }
}

async function createTemplate(manager: TemplateManager): Promise<void> {
    const name = await vscode.window.showInputBox({
        prompt: 'Template name',
        placeHolder: 'e.g., "Add Logging"'
    });
    if (!name) return;

    const prompt = await vscode.window.showInputBox({
        prompt: 'Template prompt (use {variable} for placeholders)',
        placeHolder: 'e.g., "Add logging statements to this {language} code:\\n\\n{selection}"',
        value: ''
    });
    if (!prompt) return;

    const variables = TemplateManager.extractVariables(prompt);
    await manager.save({ name, prompt, variables, builtin: false });
    vscode.window.showInformationMessage(`Template "${name}" created`);
}

async function editTemplate(manager: TemplateManager): Promise<void> {
    const custom = manager.getCustom();
    const selected = await vscode.window.showQuickPick(
        custom.map(t => ({ label: t.name, template: t })),
        { placeHolder: 'Select template to edit' }
    );
    if (!selected) return;

    const newPrompt = await vscode.window.showInputBox({
        prompt: 'Edit template prompt',
        value: selected.template.prompt
    });
    if (!newPrompt) return;

    const variables = TemplateManager.extractVariables(newPrompt);
    await manager.save({ ...selected.template, prompt: newPrompt, variables });
    vscode.window.showInformationMessage(`Template "${selected.template.name}" updated`);
}

async function deleteTemplate(manager: TemplateManager): Promise<void> {
    const custom = manager.getCustom();
    const selected = await vscode.window.showQuickPick(
        custom.map(t => ({ label: t.name, name: t.name })),
        { placeHolder: 'Select template to delete' }
    );
    if (!selected) return;

    const confirm = await vscode.window.showWarningMessage(
        `Delete template "${selected.name}"?`,
        { modal: true },
        'Delete'
    );
    if (confirm !== 'Delete') return;

    await manager.delete(selected.name);
    vscode.window.showInformationMessage(`Template "${selected.name}" deleted`);
}
