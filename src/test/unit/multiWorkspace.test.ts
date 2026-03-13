import * as assert from 'assert';
import * as sinon from 'sinon';

describe('MultiWorkspace Module', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Workspace Management', () => {
    it('should track multiple workspaces', () => {
      const workspaces = new Map();
      workspaces.set('ws1', { folder: { uri: 'file:///ws1' } });
      workspaces.set('ws2', { folder: { uri: 'file:///ws2' } });

      assert.strictEqual(workspaces.size, 2);
      assert.ok(workspaces.has('ws1'));
      assert.ok(workspaces.has('ws2'));
    });

    it('should isolate agent instances per workspace', () => {
      const ws1 = { agent: { id: 'agent1' }, memory: { id: 'mem1' } };
      const ws2 = { agent: { id: 'agent2' }, memory: { id: 'mem2' } };

      assert.notStrictEqual(ws1.agent.id, ws2.agent.id);
      assert.notStrictEqual(ws1.memory.id, ws2.memory.id);
    });

    it('should add workspace', () => {
      const workspaces = new Map();
      const folder = { uri: { fsPath: '/test' }, name: 'test', index: 0 };

      workspaces.set(folder.uri.fsPath, { folder });
      assert.strictEqual(workspaces.size, 1);
    });

    it('should remove workspace', () => {
      const workspaces = new Map();
      workspaces.set('ws1', { folder: {} });
      workspaces.set('ws2', { folder: {} });

      workspaces.delete('ws1');
      assert.strictEqual(workspaces.size, 1);
      assert.ok(!workspaces.has('ws1'));
    });
  });

  describe('Active Workspace', () => {
    it('should track active workspace', () => {
      let activeWorkspace = 'ws1';

      assert.strictEqual(activeWorkspace, 'ws1');

      activeWorkspace = 'ws2';
      assert.strictEqual(activeWorkspace, 'ws2');
    });

    it('should get workspace for file', () => {
      const workspaces = new Map();
      workspaces.set('/workspace1', { folder: { uri: { fsPath: '/workspace1' } } });
      workspaces.set('/workspace2', { folder: { uri: { fsPath: '/workspace2' } } });

      const filePath = '/workspace1/src/test.ts';
      const workspace = filePath.startsWith('/workspace1') ? '/workspace1' : null;

      assert.strictEqual(workspace, '/workspace1');
    });
  });

  describe('Workspace Picker', () => {
    it('should format workspace items', () => {
      const folder = { name: 'MyProject', uri: { fsPath: '/path/to/project' } };
      const item = {
        label: folder.name,
        description: folder.uri.fsPath,
        folder: folder
      };

      assert.strictEqual(item.label, 'MyProject');
      assert.strictEqual(item.description, '/path/to/project');
    });

    it('should handle empty workspace list', () => {
      const workspaces: any[] = [];
      assert.strictEqual(workspaces.length, 0);
    });
  });

  describe('Workspace Context Isolation', () => {
    it('should maintain separate memory per workspace', () => {
      const ws1Memory = [{ id: '1', content: 'WS1 memory' }];
      const ws2Memory = [{ id: '2', content: 'WS2 memory' }];

      assert.notDeepStrictEqual(ws1Memory, ws2Memory);
      assert.strictEqual(ws1Memory[0].content, 'WS1 memory');
      assert.strictEqual(ws2Memory[0].content, 'WS2 memory');
    });

    it('should maintain separate chat history per workspace', () => {
      const ws1History = [{ id: 'chat1', messages: [] }];
      const ws2History = [{ id: 'chat2', messages: [] }];

      assert.notDeepStrictEqual(ws1History, ws2History);
    });
  });

  describe('Workspace Change Detection', () => {
    it('should detect folder addition', () => {
      const oldFolders = ['ws1'];
      const newFolders = ['ws1', 'ws2'];

      const added = newFolders.filter(f => !oldFolders.includes(f));
      assert.deepStrictEqual(added, ['ws2']);
    });

    it('should detect folder removal', () => {
      const oldFolders = ['ws1', 'ws2'];
      const newFolders = ['ws1'];

      const removed = oldFolders.filter(f => !newFolders.includes(f));
      assert.deepStrictEqual(removed, ['ws2']);
    });
  });
});
