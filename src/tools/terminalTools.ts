import * as cp from 'child_process';
import { ToolDefinition } from '../types';
import { logInfo, logWarn } from '../logger';
import { getConfig } from '../config';

export function makeRunCommand(): ToolDefinition {
  return {
    name: 'run_command',
    description:
      'Run a shell command in the workspace root and return stdout+stderr. ' +
      'Use this for installing packages, running tests, building, git operations, etc. ' +
      'The command runs with a timeout. Avoid long-running or interactive commands.',
    parameters: {
      command: { type: 'string', description: 'The shell command to execute' },
    },
    required: ['command'],
    execute: async (args, ctx) => {
      const command = args.command as string;
      const cfg = getConfig();

      // Block obviously dangerous commands
      const blocked = ['rm -rf /', 'mkfs', ':(){', 'dd if=', '> /dev/'];
      for (const b of blocked) {
        if (command.includes(b)) {
          return `Command blocked for safety: ${command}`;
        }
      }

      logInfo(`run_command: ${command}`);
      ctx.onProgress?.(`Running: ${command}`);

      return new Promise<string>((resolve) => {
        const proc = cp.exec(command, {
          cwd: ctx.workspaceRoot,
          timeout: cfg.commandTimeout,
          maxBuffer: 1024 * 1024, // 1MB
          env: { ...process.env, FORCE_COLOR: '0' },
        }, (err, stdout, stderr) => {
          let output = '';
          if (stdout) { output += stdout; }
          if (stderr) { output += (output ? '\n--- stderr ---\n' : '') + stderr; }

          if (err) {
            if (err.killed) {
              logWarn(`Command timed out: ${command}`);
              resolve(`Command timed out after ${cfg.commandTimeout}ms.\n${output}`);
            } else {
              resolve(`Command exited with code ${err.code ?? 1}.\n${output}`);
            }
          } else {
            resolve(output || '(no output)');
          }
        });
      });
    },
  };
}
