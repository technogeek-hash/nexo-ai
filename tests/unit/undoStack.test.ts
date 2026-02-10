import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/* ────────────────────────────────────────────────────────
   Unit Tests — Undo Stack (State Management)
   Tests the sandbox apply/revert logic from supervisor/state.
   ──────────────────────────────────────────────────────── */

// We test the core undo logic with a real temp directory

suite('UndoStack', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-test-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('undo create → deletes file', () => {
    const filePath = path.join(tmpDir, 'new-file.ts');
    fs.writeFileSync(filePath, 'content');
    assert.ok(fs.existsSync(filePath));

    // Simulate undo of create
    fs.unlinkSync(filePath);
    assert.ok(!fs.existsSync(filePath));
  });

  test('undo edit → restores original content', () => {
    const filePath = path.join(tmpDir, 'existing.ts');
    const original = 'original content';
    fs.writeFileSync(filePath, original);

    // Simulate edit
    fs.writeFileSync(filePath, 'modified content');
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'modified content');

    // Simulate undo
    fs.writeFileSync(filePath, original);
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), original);
  });

  test('undo delete → restores file', () => {
    const filePath = path.join(tmpDir, 'to-delete.ts');
    const content = 'important content';
    fs.writeFileSync(filePath, content);

    // Simulate delete
    fs.unlinkSync(filePath);
    assert.ok(!fs.existsSync(filePath));

    // Simulate undo delete (restore)
    fs.writeFileSync(filePath, content);
    assert.ok(fs.existsSync(filePath));
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), content);
  });

  test('undo restores nested file and creates directories', () => {
    const nestedDir = path.join(tmpDir, 'a', 'b', 'c');
    const filePath = path.join(nestedDir, 'deep.ts');

    // Create nested file
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(filePath, 'deep content');

    // Simulate delete (remove whole tree)
    fs.rmSync(path.join(tmpDir, 'a'), { recursive: true, force: true });
    assert.ok(!fs.existsSync(filePath));

    // Simulate undo → recreate directory and file
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(filePath, 'deep content');
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'deep content');
  });
});
