import { ChatMessage, StreamEvent } from '../types';
import { chatCompletion } from '../client/nvidiaClient';
import { logInfo } from '../logger';

/**
 * Generate a concise, human-readable explanation of what changed and why.
 */
export async function explainChanges(
  goal: string,
  changedFiles: string[],
  summary: string,
): Promise<string> {
  if (changedFiles.length === 0) {
    return 'No files were changed.';
  }

  try {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are a helpful assistant. Summarize code changes in 2-3 concise sentences for a developer. Focus on WHAT changed and WHY.',
      },
      {
        role: 'user',
        content: `Goal: ${goal}\n\nFiles changed: ${changedFiles.join(', ')}\n\nAgent summary: ${summary}\n\nPlease provide a brief summary of the changes.`,
      },
    ];

    const explanation = await chatCompletion({ messages, maxTokens: 300 });
    return explanation;
  } catch {
    // Fallback to a basic summary
    return `Changed ${changedFiles.length} file(s): ${changedFiles.join(', ')}\nGoal: ${goal}`;
  }
}
