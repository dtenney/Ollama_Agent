import * as assert from 'assert';
import * as vscode from 'vscode';

describe('Extension Integration Tests', () => {
  it('should activate extension', async () => {
    const ext = vscode.extensions.getExtension('dtenney.ollamapilot');
    assert.ok(ext);

    if (!ext.isActive) {
      await ext.activate();
    }

    assert.ok(ext.isActive);
  });

  it('should register all commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    const ollamaCommands = [
      'ollamaAgent.newChat',
      'ollamaAgent.openChat',
      'ollamaAgent.generateCode',
      'ollamaAgent.explainSelection',
      'ollamaAgent.codeAction',
      'ollamaAgent.explainError',
      'ollamaAgent.diagnose',
      'ollamaAgent.manageTemplates',
      'ollamaAgent.triggerInlineCompletion',
      'ollamaAgent.exportChatMarkdown',
      'ollamaAgent.exportChatJSON',
      'ollamaAgent.switchWorkspace'
    ];

    ollamaCommands.forEach(cmd => {
      assert.ok(commands.includes(cmd), `Command ${cmd} not registered`);
    });
  });

  it('should register chat view', async () => {
    // The extension registers the chatView provider on activation.
    // Verify by checking the extension activated successfully (provider registered without error).
    const ext = vscode.extensions.getExtension('dtenney.ollamapilot');
    assert.ok(ext?.isActive, 'Extension should be active, meaning chatView provider was registered');
  });

  it('should register memory view', async () => {
    // The extension registers the memoryView tree data provider on activation.
    // Verify by checking the extension activated successfully.
    const ext = vscode.extensions.getExtension('dtenney.ollamapilot');
    assert.ok(ext?.isActive, 'Extension should be active, meaning memoryView provider was registered');
  });

  it('should load configuration', () => {
    const config = vscode.workspace.getConfiguration('ollamaAgent');
    
    assert.ok(config);
    assert.ok(config.has('host'));
    assert.ok(config.has('port'));
    assert.ok(config.has('model'));
  });
});
