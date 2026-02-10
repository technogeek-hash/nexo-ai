import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logError } from './logger';

/* ────────────────────────────────────────────────────────
   Audit Logger — writes all agent-applied changes to a
   workspace-local file: .nexo-ai/audit.log
   Controlled by the user.  Never leaves the machine.
   ──────────────────────────────────────────────────────── */

export interface AuditEntry {
  timestamp: string;
  action: 'tool_call' | 'file_create' | 'file_edit' | 'file_delete' | 'command_run' | 'task_start' | 'task_end' | 'undo';
  detail: string;
  tool?: string;
  file?: string;
  taskId?: string;
}

let _auditDir: string | undefined;
let _buffer: string[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | undefined;

/** Initialise audit logging for a workspace root. */
export function initAudit(workspaceRoot: string): void {
  _auditDir = path.join(workspaceRoot, '.nexo-ai');
}

/** Log an audit entry. Batches writes for performance. */
export function auditLog(entry: AuditEntry): void {
  if (!_auditDir) { return; }

  const line = JSON.stringify({
    ...entry,
    timestamp: entry.timestamp || new Date().toISOString(),
  });

  _buffer.push(line);

  // Debounced flush — write at most every 500ms
  if (!_flushTimer) {
    _flushTimer = setTimeout(flushAuditBuffer, 500);
  }
}

/** Convenience helpers. */
export function auditToolCall(taskId: string, tool: string, args: Record<string, unknown>, file?: string): void {
  auditLog({
    timestamp: new Date().toISOString(),
    action: 'tool_call',
    detail: `${tool}(${JSON.stringify(args).slice(0, 200)})`,
    tool,
    file,
    taskId,
  });
}

export function auditTaskStart(taskId: string, goal: string): void {
  auditLog({
    timestamp: new Date().toISOString(),
    action: 'task_start',
    detail: goal.slice(0, 500),
    taskId,
  });
}

export function auditTaskEnd(taskId: string, success: boolean, summary: string): void {
  auditLog({
    timestamp: new Date().toISOString(),
    action: 'task_end',
    detail: `success=${success} ${summary.slice(0, 200)}`,
    taskId,
  });
}

export function auditUndo(taskId: string, count: number): void {
  auditLog({
    timestamp: new Date().toISOString(),
    action: 'undo',
    detail: `Reverted ${count} change(s)`,
    taskId,
  });
}

function flushAuditBuffer(): void {
  _flushTimer = undefined;
  if (!_auditDir || _buffer.length === 0) { return; }

  try {
    if (!fs.existsSync(_auditDir)) {
      fs.mkdirSync(_auditDir, { recursive: true });
    }

    const logPath = path.join(_auditDir, 'audit.log');
    const data = _buffer.join('\n') + '\n';
    fs.appendFileSync(logPath, data, 'utf-8');
    _buffer = [];
  } catch (err) {
    logError('Failed to flush audit log', err);
  }
}

/** Force-flush any pending audit entries (call on deactivate). */
export function flushAudit(): void {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = undefined;
  }
  flushAuditBuffer();
}
