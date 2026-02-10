import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logWarn, logError } from '../logger';

/* ────────────────────────────────────────────────────────
   Agent YAML/JSON Loader & Validator
   Loads and validates custom agent definitions from
   .nexo-ai/agents.yaml (or agents.json) in the workspace.
   ──────────────────────────────────────────────────────── */

export interface AgentPermissions {
  readFiles: boolean;
  writeFiles: boolean;
  deleteFiles: boolean;
  runCommands: boolean;
  filePatterns?: string[];
}

export interface AgentDefinition {
  name: string;
  role: 'planner' | 'coder' | 'reviewer' | 'custom';
  prompt: string;
  model?: string;
  temperature?: number;
  maxIterations?: number;
  permissions: AgentPermissions;
}

export interface AgentPipeline {
  agents: AgentDefinition[];
  pipeline: string[];
  reviewRequired: boolean;
}

export interface ValidationError {
  path: string;
  message: string;
}

const DEFAULT_PERMISSIONS: AgentPermissions = {
  readFiles: true,
  writeFiles: false,
  deleteFiles: false,
  runCommands: false,
};

const VALID_ROLES = new Set(['planner', 'coder', 'reviewer', 'custom']);
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Load agent definitions from the workspace's .nexo-ai/ directory.
 * Supports both YAML (.yaml/.yml) and JSON (.json) formats.
 * Returns `undefined` if no config file is found (uses built-in defaults).
 */
export async function loadAgentConfig(workspaceRoot: string): Promise<AgentPipeline | undefined> {
  const candidates = [
    path.join(workspaceRoot, '.nexo-ai', 'agents.yaml'),
    path.join(workspaceRoot, '.nexo-ai', 'agents.yml'),
    path.join(workspaceRoot, '.nexo-ai', 'agents.json'),
  ];

  let configPath: string | undefined;
  let raw: string | undefined;

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        raw = fs.readFileSync(candidate, 'utf-8');
        configPath = candidate;
        break;
      }
    } catch { /* skip */ }
  }

  if (!configPath || !raw) {
    return undefined; // No custom config — use defaults
  }

  logInfo(`Loading agent config from ${configPath}`);

  // Parse the file
  let parsed: unknown;
  try {
    if (configPath.endsWith('.json')) {
      parsed = JSON.parse(raw);
    } else {
      parsed = parseSimpleYaml(raw);
    }
  } catch (err) {
    logError(`Failed to parse agent config: ${configPath}`, err);
    throw new Error(`Invalid agent config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Validate
  const errors = validateAgentConfig(parsed);
  if (errors.length > 0) {
    const msg = errors.map(e => `  ${e.path}: ${e.message}`).join('\n');
    logError(`Agent config validation failed:\n${msg}`);
    throw new Error(`Agent config validation errors:\n${msg}`);
  }

  const config = parsed as Record<string, unknown>;
  return buildPipeline(config);
}

/* ─── Validation ─── */

export function validateAgentConfig(data: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!data || typeof data !== 'object') {
    errors.push({ path: '$', message: 'Config must be an object.' });
    return errors;
  }

  const obj = data as Record<string, unknown>;

  // Validate agents array
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

        // name
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

        // role
        if (typeof a.role !== 'string' || !VALID_ROLES.has(a.role)) {
          errors.push({ path: `${prefix}.role`, message: `Must be one of: ${[...VALID_ROLES].join(', ')}.` });
        }

        // prompt
        if (typeof a.prompt !== 'string' || a.prompt.length < 10) {
          errors.push({ path: `${prefix}.prompt`, message: 'Required, must be at least 10 characters.' });
        } else if (a.prompt.length > 10_000) {
          errors.push({ path: `${prefix}.prompt`, message: 'Must be 10,000 characters or fewer.' });
        }

        // model (optional)
        if ('model' in a && typeof a.model !== 'string') {
          errors.push({ path: `${prefix}.model`, message: 'Must be a string.' });
        }

        // temperature (optional)
        if ('temperature' in a) {
          if (typeof a.temperature !== 'number' || a.temperature < 0 || a.temperature > 2) {
            errors.push({ path: `${prefix}.temperature`, message: 'Must be a number between 0 and 2.' });
          }
        }

        // maxIterations (optional)
        if ('maxIterations' in a) {
          if (typeof a.maxIterations !== 'number' || !Number.isInteger(a.maxIterations) || a.maxIterations < 1 || a.maxIterations > 100) {
            errors.push({ path: `${prefix}.maxIterations`, message: 'Must be an integer between 1 and 100.' });
          }
        }

        // permissions (optional)
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

        // Reject unknown keys
        const KNOWN_KEYS = new Set(['name', 'role', 'prompt', 'model', 'temperature', 'maxIterations', 'permissions']);
        for (const key of Object.keys(a)) {
          if (!KNOWN_KEYS.has(key)) {
            errors.push({ path: `${prefix}.${key}`, message: `Unknown property "${key}".` });
          }
        }
      });
    }
  }

  // Validate pipeline
  if ('pipeline' in obj) {
    if (!Array.isArray(obj.pipeline) || !obj.pipeline.every((v: unknown) => typeof v === 'string')) {
      errors.push({ path: '$.pipeline', message: 'Must be an array of agent name strings.' });
    }
  }

  // Validate reviewRequired
  if ('reviewRequired' in obj && typeof obj.reviewRequired !== 'boolean') {
    errors.push({ path: '$.reviewRequired', message: 'Must be a boolean.' });
  }

  // Reject unknown top-level keys
  const KNOWN_TOP = new Set(['agents', 'pipeline', 'reviewRequired']);
  for (const key of Object.keys(obj)) {
    if (!KNOWN_TOP.has(key)) {
      errors.push({ path: `$.${key}`, message: `Unknown property "${key}".` });
    }
  }

  return errors;
}

/* ─── Build pipeline from validated config ─── */

function buildPipeline(config: Record<string, unknown>): AgentPipeline {
  const rawAgents = (config.agents as unknown[]) ?? [];
  const agents: AgentDefinition[] = rawAgents.map((a: any) => ({
    name: a.name,
    role: a.role,
    prompt: a.prompt,
    model: a.model,
    temperature: a.temperature,
    maxIterations: a.maxIterations,
    permissions: {
      ...DEFAULT_PERMISSIONS,
      ...((a.permissions as Partial<AgentPermissions>) ?? {}),
    },
  }));

  const pipeline = (config.pipeline as string[]) ?? ['planner', 'coder', 'reviewer'];
  const reviewRequired = (config.reviewRequired as boolean) ?? true;

  return { agents, pipeline, reviewRequired };
}

/* ─── Simple YAML parser (subset) ─── 
   Handles the agent config YAML format without external deps.
   Falls back to JSON-like structure.  For full YAML support,
   users should use agents.json instead.
*/

function parseSimpleYaml(raw: string): unknown {
  // Try JSON first (YAML is a superset of JSON)
  try {
    return JSON.parse(raw);
  } catch { /* not JSON, try basic YAML parsing */ }

  // Basic YAML: supports key: value, arrays with -, nested objects
  // For production, recommend users install the `yaml` npm package
  // or use the .json format for full fidelity.
  logWarn('Using built-in simple YAML parser. For complex YAML configs, consider using agents.json format.');

  const lines = raw.split('\n');
  const result: Record<string, unknown> = {};
  let currentArray: unknown[] | undefined;
  let currentArrayKey: string | undefined;
  let currentObj: Record<string, unknown> | undefined;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith('#')) { continue; }

    const indent = line.length - line.trimStart().length;

    // Top-level key: value
    const kvMatch = trimmed.match(/^(\w+):\s*(.*)/);
    if (kvMatch && indent === 0) {
      // Flush current array
      if (currentArray && currentArrayKey) {
        result[currentArrayKey] = currentArray;
        currentArray = undefined;
        currentArrayKey = undefined;
      }

      const key = kvMatch[1];
      const val = kvMatch[2].trim();

      if (!val) {
        // Could be an array or object on next lines
        currentArrayKey = key;
        currentArray = [];
      } else {
        result[key] = parseYamlValue(val);
      }
      currentObj = undefined;
      continue;
    }

    // Array item
    if (trimmed.match(/^\s*-\s+/) && currentArrayKey) {
      if (!currentArray) { currentArray = []; }
      const itemContent = trimmed.replace(/^\s*-\s+/, '');
      const itemKv = itemContent.match(/^(\w+):\s*(.*)/);
      if (itemKv) {
        currentObj = { [itemKv[1]]: parseYamlValue(itemKv[2].trim()) };
        currentArray.push(currentObj);
      } else {
        currentArray.push(parseYamlValue(itemContent));
        currentObj = undefined;
      }
      continue;
    }

    // Nested key in current object
    if (currentObj && indent > 0) {
      const nestedKv = trimmed.match(/^\s+(\w+):\s*(.*)/);
      if (nestedKv) {
        const key = nestedKv[1];
        const val = nestedKv[2].trim();
        if (!val) {
          // Sub-object
          const subObj: Record<string, unknown> = {};
          currentObj[key] = subObj;
          // Note: deeper nesting would need a stack-based parser
        } else {
          currentObj[key] = parseYamlValue(val);
        }
      }
    }
  }

  // Flush final array
  if (currentArray && currentArrayKey) {
    result[currentArrayKey] = currentArray;
  }

  return result;
}

function parseYamlValue(val: string): unknown {
  if (!val || val === '~' || val === 'null') { return null; }
  if (val === 'true') { return true; }
  if (val === 'false') { return false; }
  const num = Number(val);
  if (!isNaN(num) && val !== '') { return num; }
  // Remove surrounding quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  // Inline array
  if (val.startsWith('[') && val.endsWith(']')) {
    try { return JSON.parse(val); } catch { /* fall through */ }
  }
  return val;
}
