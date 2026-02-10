import * as assert from 'assert';

/* ────────────────────────────────────────────────────────
   Unit Tests — Agent Config Validation
   Self-contained: replicates the validation logic from
   src/agents/yamlLoader.ts to run outside VS Code host.
   ──────────────────────────────────────────────────────── */

interface ValidationError {
  path: string;
  message: string;
}

const VALID_ROLES = new Set(['planner', 'coder', 'reviewer', 'custom']);
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function validateAgentConfig(data: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!data || typeof data !== 'object') {
    errors.push({ path: '$', message: 'Config must be an object.' });
    return errors;
  }

  const obj = data as Record<string, unknown>;

  if ('agents' in obj) {
    if (!Array.isArray(obj.agents)) {
      errors.push({ path: '$.agents', message: 'Must be an array.' });
    } else {
      const names = new Set<string>();
      obj.agents.forEach((agent: unknown, i: number) => {
        const prefix = `$.agents[${i}]`;

        if (!agent || typeof agent !== 'object') {
          errors.push({ path: prefix, message: 'Each agent must be an object.' });
          return;
        }

        const a = agent as Record<string, unknown>;

        if (typeof a.name !== 'string' || !a.name) {
          errors.push({ path: `${prefix}.name`, message: 'Required, must be a non-empty string.' });
        } else if (!NAME_PATTERN.test(a.name)) {
          errors.push({ path: `${prefix}.name`, message: 'Must match pattern [a-zA-Z][a-zA-Z0-9_-]*.' });
        } else if (a.name.length > 64) {
          errors.push({ path: `${prefix}.name`, message: 'Must be 64 characters or fewer.' });
        } else if (names.has(a.name)) {
          errors.push({ path: `${prefix}.name`, message: `Duplicate agent name "${a.name}".` });
        } else {
          names.add(a.name);
        }

        if (typeof a.role !== 'string' || !VALID_ROLES.has(a.role)) {
          errors.push({ path: `${prefix}.role`, message: `Must be one of: ${[...VALID_ROLES].join(', ')}.` });
        }

        if (typeof a.prompt !== 'string' || a.prompt.length < 10) {
          errors.push({ path: `${prefix}.prompt`, message: 'Required, must be at least 10 characters.' });
        } else if (a.prompt.length > 10_000) {
          errors.push({ path: `${prefix}.prompt`, message: 'Must be 10,000 characters or fewer.' });
        }

        if ('model' in a && typeof a.model !== 'string') {
          errors.push({ path: `${prefix}.model`, message: 'Must be a string.' });
        }

        if ('temperature' in a) {
          if (typeof a.temperature !== 'number' || a.temperature < 0 || a.temperature > 2) {
            errors.push({ path: `${prefix}.temperature`, message: 'Must be a number between 0 and 2.' });
          }
        }

        if ('maxIterations' in a) {
          if (typeof a.maxIterations !== 'number' || !Number.isInteger(a.maxIterations) || a.maxIterations < 1 || a.maxIterations > 100) {
            errors.push({ path: `${prefix}.maxIterations`, message: 'Must be an integer between 1 and 100.' });
          }
        }

        if ('permissions' in a) {
          const perms = a.permissions;
          if (!perms || typeof perms !== 'object') {
            errors.push({ path: `${prefix}.permissions`, message: 'Must be an object.' });
          } else {
            const p = perms as Record<string, unknown>;
            for (const boolKey of ['readFiles', 'writeFiles', 'deleteFiles', 'runCommands']) {
              if (boolKey in p && typeof p[boolKey] !== 'boolean') {
                errors.push({ path: `${prefix}.permissions.${boolKey}`, message: 'Must be a boolean.' });
              }
            }
            if ('filePatterns' in p) {
              if (!Array.isArray(p.filePatterns) || !p.filePatterns.every((v: unknown) => typeof v === 'string')) {
                errors.push({ path: `${prefix}.permissions.filePatterns`, message: 'Must be an array of strings.' });
              }
            }
          }
        }

        const KNOWN_KEYS = new Set(['name', 'role', 'prompt', 'model', 'temperature', 'maxIterations', 'permissions']);
        for (const key of Object.keys(a)) {
          if (!KNOWN_KEYS.has(key)) {
            errors.push({ path: `${prefix}.${key}`, message: `Unknown property "${key}".` });
          }
        }
      });
    }
  }

  if ('pipeline' in obj) {
    if (!Array.isArray(obj.pipeline) || !obj.pipeline.every((v: unknown) => typeof v === 'string')) {
      errors.push({ path: '$.pipeline', message: 'Must be an array of agent name strings.' });
    }
  }

  if ('reviewRequired' in obj && typeof obj.reviewRequired !== 'boolean') {
    errors.push({ path: '$.reviewRequired', message: 'Must be a boolean.' });
  }

  const KNOWN_TOP = new Set(['agents', 'pipeline', 'reviewRequired']);
  for (const key of Object.keys(obj)) {
    if (!KNOWN_TOP.has(key)) {
      errors.push({ path: `$.${key}`, message: `Unknown property "${key}".` });
    }
  }

  return errors;
}

suite('validateAgentConfig', () => {
  const validConfig = {
    agents: [
      {
        name: 'my-planner',
        role: 'planner',
        prompt: 'You are an expert planning agent that creates detailed implementation plans.',
      },
      {
        name: 'my-coder',
        role: 'coder',
        prompt: 'You are an expert software engineer who writes clean code.',
        model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
        temperature: 0.7,
        maxIterations: 20,
        permissions: {
          readFiles: true,
          writeFiles: true,
          deleteFiles: false,
          runCommands: false,
          filePatterns: ['src/**/*.ts'],
        },
      },
    ],
    pipeline: ['my-planner', 'my-coder'],
    reviewRequired: true,
  };

  test('accepts a valid config', () => {
    const errors = validateAgentConfig(validConfig);
    assert.strictEqual(errors.length, 0);
  });

  test('rejects non-object config', () => {
    const errors = validateAgentConfig('not an object');
    assert.ok(errors.length > 0);
    assert.ok(errors[0].message.includes('object'));
  });

  test('rejects null config', () => {
    assert.ok(validateAgentConfig(null).length > 0);
  });

  test('rejects agents that is not an array', () => {
    const errors = validateAgentConfig({ agents: 'not-array' });
    assert.ok(errors.some(e => e.path === '$.agents'));
  });

  test('rejects agent without name', () => {
    const errors = validateAgentConfig({
      agents: [{ role: 'coder', prompt: 'A sufficiently long prompt for testing.' }],
    });
    assert.ok(errors.some(e => e.path.includes('name')));
  });

  test('rejects agent with invalid name pattern', () => {
    const errors = validateAgentConfig({
      agents: [{ name: '123-bad', role: 'coder', prompt: 'A sufficiently long prompt for testing.' }],
    });
    assert.ok(errors.some(e => e.message.includes('pattern')));
  });

  test('rejects duplicate agent names', () => {
    const errors = validateAgentConfig({
      agents: [
        { name: 'dup', role: 'coder', prompt: 'First agent with this name.' },
        { name: 'dup', role: 'planner', prompt: 'Second agent with this name.' },
      ],
    });
    assert.ok(errors.some(e => e.message.includes('Duplicate')));
  });

  test('rejects invalid role', () => {
    const errors = validateAgentConfig({
      agents: [{ name: 'test', role: 'invalid', prompt: 'A sufficiently long prompt for testing.' }],
    });
    assert.ok(errors.some(e => e.path.includes('role')));
  });

  test('rejects prompt shorter than 10 chars', () => {
    const errors = validateAgentConfig({
      agents: [{ name: 'test', role: 'coder', prompt: 'short' }],
    });
    assert.ok(errors.some(e => e.path.includes('prompt')));
  });

  test('rejects temperature out of range', () => {
    const errors = validateAgentConfig({
      agents: [{ name: 'test', role: 'coder', prompt: 'A sufficiently long prompt.', temperature: 5 }],
    });
    assert.ok(errors.some(e => e.path.includes('temperature')));
  });

  test('rejects non-integer maxIterations', () => {
    const errors = validateAgentConfig({
      agents: [{ name: 'test', role: 'coder', prompt: 'A sufficiently long prompt.', maxIterations: 3.5 }],
    });
    assert.ok(errors.some(e => e.path.includes('maxIterations')));
  });

  test('rejects maxIterations out of range', () => {
    const errors1 = validateAgentConfig({
      agents: [{ name: 'test', role: 'coder', prompt: 'A sufficiently long prompt.', maxIterations: 0 }],
    });
    assert.ok(errors1.some(e => e.path.includes('maxIterations')));

    const errors2 = validateAgentConfig({
      agents: [{ name: 'test', role: 'coder', prompt: 'A sufficiently long prompt.', maxIterations: 200 }],
    });
    assert.ok(errors2.some(e => e.path.includes('maxIterations')));
  });

  test('rejects invalid permissions type', () => {
    const errors = validateAgentConfig({
      agents: [{ name: 'test', role: 'coder', prompt: 'A sufficiently long prompt.', permissions: 'bad' }],
    });
    assert.ok(errors.some(e => e.path.includes('permissions')));
  });

  test('rejects non-boolean permission values', () => {
    const errors = validateAgentConfig({
      agents: [{
        name: 'test', role: 'coder', prompt: 'A sufficiently long prompt.',
        permissions: { writeFiles: 'yes' },
      }],
    });
    assert.ok(errors.some(e => e.message.includes('boolean')));
  });

  test('rejects invalid filePatterns', () => {
    const errors = validateAgentConfig({
      agents: [{
        name: 'test', role: 'coder', prompt: 'A sufficiently long prompt.',
        permissions: { filePatterns: [123] },
      }],
    });
    assert.ok(errors.some(e => e.path.includes('filePatterns')));
  });

  test('rejects unknown agent properties', () => {
    const errors = validateAgentConfig({
      agents: [{
        name: 'test', role: 'coder', prompt: 'A sufficiently long prompt.',
        unknownField: true,
      }],
    });
    assert.ok(errors.some(e => e.message.includes('Unknown')));
  });

  test('rejects unknown top-level properties', () => {
    const errors = validateAgentConfig({ agents: [], extraField: 123 });
    assert.ok(errors.some(e => e.message.includes('Unknown')));
  });

  test('rejects non-boolean reviewRequired', () => {
    const errors = validateAgentConfig({ reviewRequired: 'yes' });
    assert.ok(errors.some(e => e.path === '$.reviewRequired'));
  });

  test('rejects non-array pipeline', () => {
    const errors = validateAgentConfig({ pipeline: 'bad' });
    assert.ok(errors.some(e => e.path === '$.pipeline'));
  });

  test('accepts config with only pipeline', () => {
    const errors = validateAgentConfig({ pipeline: ['planner', 'coder'] });
    assert.strictEqual(errors.length, 0);
  });

  test('accepts empty agents array', () => {
    const errors = validateAgentConfig({ agents: [] });
    assert.strictEqual(errors.length, 0);
  });
});
