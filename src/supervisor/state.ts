import { AgentState, FileEdit, ChatMessage } from '../types';
import { logInfo } from '../logger';

let _stateId = 0;

/** Create a fresh agent state for a new task. */
export function createAgentState(goal: string, maxIterations: number): AgentState {
  return {
    id: `task-${++_stateId}-${Date.now()}`,
    goal,
    edits: [],
    messages: [],
    iteration: 0,
    maxIterations,
    status: 'planning',
  };
}

/** Immutable state update helper. */
export function updateState(state: AgentState, patch: Partial<AgentState>): AgentState {
  return { ...state, ...patch };
}

/* ──────────── Undo Stack ──────────── */

import * as fs from 'fs';
import * as path from 'path';

export interface UndoEntry {
  taskId: string;
  timestamp: number;
  edits: FileEdit[];
}

const undoStack: UndoEntry[] = [];

/** Record edits for later undo. Captures original file contents. */
export function recordEdits(taskId: string, workspaceRoot: string, edits: FileEdit[]): void {
  const enriched: FileEdit[] = edits.map(e => {
    const abs = path.resolve(workspaceRoot, e.filePath);
    let originalContent: string | undefined;
    try {
      if (fs.existsSync(abs)) {
        originalContent = fs.readFileSync(abs, 'utf-8');
      }
    } catch { /* ignore */ }
    return { ...e, originalContent };
  });

  undoStack.push({ taskId, timestamp: Date.now(), edits: enriched });
  logInfo(`Recorded ${edits.length} edits for undo (task ${taskId})`);
}

/** Undo the most recent task's edits. */
export function undoLastTask(workspaceRoot: string): { undone: boolean; taskId?: string; count: number } {
  const entry = undoStack.pop();
  if (!entry) { return { undone: false, count: 0 }; }

  let count = 0;
  for (const edit of entry.edits.reverse()) {
    const abs = path.resolve(workspaceRoot, edit.filePath);
    try {
      if (edit.type === 'create') {
        // Undo create → delete
        if (fs.existsSync(abs)) { fs.unlinkSync(abs); count++; }
      } else if (edit.type === 'delete' && edit.originalContent !== undefined) {
        // Undo delete → restore
        const dir = path.dirname(abs);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
        fs.writeFileSync(abs, edit.originalContent, 'utf-8');
        count++;
      } else if (edit.type === 'edit' && edit.originalContent !== undefined) {
        // Undo edit → restore original
        fs.writeFileSync(abs, edit.originalContent, 'utf-8');
        count++;
      }
    } catch (err) {
      logInfo(`Failed to undo edit for ${edit.filePath}: ${err}`);
    }
  }

  logInfo(`Undid ${count} edits from task ${entry.taskId}`);
  return { undone: true, taskId: entry.taskId, count };
}

/** Check if there are edits that can be undone. */
export function canUndo(): boolean {
  return undoStack.length > 0;
}
