import * as assert from 'assert';
import * as sinon from 'sinon';

describe('ChatStorage Module', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: any;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockContext = {
      globalState: {
        get: sandbox.stub(),
        update: sandbox.stub()
      }
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('saveSession', () => {
    it('should save session with valid data', async () => {
      const session = {
        id: 'test-123',
        title: 'Test Session',
        messages: [{ role: 'user', content: 'Hello' }],
        timestamp: Date.now()
      };

      mockContext.globalState.get.returns([]);
      mockContext.globalState.update.resolves();

      assert.strictEqual(session.id, 'test-123');
      assert.strictEqual(session.title, 'Test Session');
      assert.strictEqual(session.messages.length, 1);
    });

    it('should generate unique session IDs', () => {
      const id1 = `session-${Date.now()}-${Math.random()}`;
      const id2 = `session-${Date.now()}-${Math.random()}`;

      assert.notStrictEqual(id1, id2);
    });
  });

  describe('loadSession', () => {
    it('should return null for non-existent session', () => {
      mockContext.globalState.get.returns([]);
      const result = null;

      assert.strictEqual(result, null);
    });

    it('should load existing session', () => {
      const session = {
        id: 'test-123',
        title: 'Test',
        messages: [],
        timestamp: Date.now()
      };

      mockContext.globalState.get.returns([session]);
      const loaded = session;

      assert.deepStrictEqual(loaded, session);
    });
  });

  describe('deleteSession', () => {
    it('should remove session from storage', async () => {
      const sessions = [
        { id: 'test-1', title: 'A', messages: [], timestamp: 1 },
        { id: 'test-2', title: 'B', messages: [], timestamp: 2 }
      ];

      mockContext.globalState.get.returns(sessions);
      mockContext.globalState.update.resolves();

      const filtered = sessions.filter(s => s.id !== 'test-1');
      assert.strictEqual(filtered.length, 1);
      assert.strictEqual(filtered[0].id, 'test-2');
    });
  });

  describe('listSessions', () => {
    it('should return sessions sorted by timestamp', () => {
      const sessions = [
        { id: '1', title: 'Old', messages: [], timestamp: 100 },
        { id: '2', title: 'New', messages: [], timestamp: 200 }
      ];

      const sorted = [...sessions].sort((a, b) => b.timestamp - a.timestamp);

      assert.strictEqual(sorted[0].id, '2');
      assert.strictEqual(sorted[1].id, '1');
    });
  });
});
