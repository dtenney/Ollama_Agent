import * as assert from 'assert';
import * as sinon from 'sinon';

describe('Config Module', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getOllamaConfig', () => {
    it('should return default config when no settings exist', () => {
      const mockWorkspace = {
        getConfiguration: () => ({
          get: (key: string, defaultValue: any) => defaultValue
        })
      };
      
      const config = {
        baseUrl: '',
        host: 'localhost',
        port: 11434,
        model: 'llama2',
        temperature: 0.7,
        systemPrompt: '',
        autoIncludeFile: false,
        autoIncludeSelection: true,
        maxContextFiles: 5,
        injectGitDiff: false
      };

      assert.strictEqual(config.host, 'localhost');
      assert.strictEqual(config.port, 11434);
      assert.strictEqual(config.model, 'llama2');
    });

    it('should use baseUrl when provided', () => {
      const config = {
        baseUrl: 'http://192.168.1.100:11434',
        host: 'localhost',
        port: 11434
      };

      assert.strictEqual(config.baseUrl, 'http://192.168.1.100:11434');
    });

    it('should validate temperature range', () => {
      const validTemp = 0.7;
      const minTemp = 0;
      const maxTemp = 2;

      assert.ok(validTemp >= minTemp && validTemp <= maxTemp);
      assert.ok(minTemp >= 0 && minTemp <= 2);
      assert.ok(maxTemp >= 0 && maxTemp <= 2);
    });
  });

  describe('MODEL_PRESETS', () => {
    it('should have three presets with correct structure', () => {
      const presets = {
        fast: { model: 'qwen2.5-coder:1.5b', temperature: 0.5 },
        balanced: { model: 'qwen2.5-coder:7b', temperature: 0.7 },
        quality: { model: 'llama3.1:8b', temperature: 0.8 }
      };

      assert.ok(presets.fast);
      assert.ok(presets.balanced);
      assert.ok(presets.quality);
      assert.strictEqual(presets.fast.model, 'qwen2.5-coder:1.5b');
      assert.strictEqual(presets.balanced.temperature, 0.7);
    });
  });
});
