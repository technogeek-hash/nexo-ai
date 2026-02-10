import * as assert from 'assert';
import * as vscode from 'vscode';

/* ────────────────────────────────────────────────────────
   E2E Smoke Test — Extension Development Host
   Verifies that the extension activates and basic
   commands are registered.
   ──────────────────────────────────────────────────────── */

suite('Extension Smoke Tests', () => {
  test('extension is present', () => {
    const ext = vscode.extensions.getExtension('nexo-ai.nexo-agent');
    assert.ok(ext, 'Extension should be installed');
  });

  test('extension activates', async () => {
    const ext = vscode.extensions.getExtension('nexo-ai.nexo-agent');
    assert.ok(ext);
    await ext.activate();
    assert.ok(ext.isActive, 'Extension should be active after activation');
  });

  test('registers expected commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    const expected = [
      'nexoAgent.runAgent',
      'nexoAgent.explainCode',
      'nexoAgent.fixCode',
      'nexoAgent.refactorCode',
      'nexoAgent.addTests',
      'nexoAgent.addDocs',
      'nexoAgent.fixErrors',
      'nexoAgent.createApp',
      'nexoAgent.undo',
      'nexoAgent.openSettings',
      'nexoAgent.focusChat',
      'nexoAgent.setApiKey',
      'nexoAgent.deleteApiKey',
      'nexoAgent.setOpenRouterApiKey',
      'nexoAgent.deleteOpenRouterApiKey',
      'nexoAgent.switchProvider',
      'nexoAgent.resetTokens',
    ];

    for (const cmd of expected) {
      assert.ok(commands.includes(cmd), `Command "${cmd}" should be registered`);
    }
  });

  test('sidebar view is registered', () => {
    const ext = vscode.extensions.getExtension('nexo-ai.nexo-agent');
    assert.ok(ext);
    // package.json declares the view under the "nexo-agent" activity bar container
    assert.ok(ext.packageJSON?.contributes?.views?.['nexo-agent']?.length > 0);
  });
});
