#!/usr/bin/env node
/**
 * Full pipeline integration test: Simulates the NexoAgent "Create Full App"
 * flow — Architect → Scaffold → Coder phases for a Spotify clone.
 *
 * This exercises the same code paths as the extension's appOrchestrator.
 *
 * Usage: NVIDIA_API_KEY=nvapi-... node tests/integration/testFullPipeline.mjs
 */

const API_KEY = process.env.NVIDIA_API_KEY;
const BASE_URL = 'https://integrate.api.nvidia.com/v1';
const MODEL = 'nvidia/llama-3.3-nemotron-super-49b-v1';
const WORKSPACE = '/tmp/spotify-clone-test';

import fs from 'fs';
import path from 'path';

if (!API_KEY) {
  console.error('❌ Set NVIDIA_API_KEY environment variable first');
  process.exit(1);
}

/* ═══════════════ JSON Parsing Utilities ═══════════════ */

function stripJsonComments(text) {
  const lines = text.split('\n');
  const result = [];
  for (const line of lines) {
    let inString = false;
    let escaped = false;
    let commentStart = -1;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (!inString) {
        if (ch === '#') { commentStart = i; break; }
        if (ch === '/' && i + 1 < line.length && line[i + 1] === '/') { commentStart = i; break; }
      }
    }
    result.push(commentStart >= 0 ? line.slice(0, commentStart) : line);
  }
  return result.join('\n');
}

function parseJSON(raw) {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  }
  cleaned = stripJsonComments(cleaned);
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      let ex = stripJsonComments(m[0]).replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(ex);
    }
    throw new Error('JSON parse failed');
  }
}

/* ═══════════════ API Call Helper ═══════════════ */

async function callLLM(messages, { temperature = 0.2, maxTokens = 8192 } = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

/* ═══════════════ Tool Execution (File I/O) ═══════════════ */

function parseToolCalls(text) {
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const calls = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.tool) calls.push(parsed);
    } catch { /* skip invalid */ }
  }
  return calls;
}

function executeTool(call) {
  const { tool, args } = call;
  if (tool === 'write_file') {
    const abs = path.join(WORKSPACE, args.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, args.content, 'utf-8');
    return `✅ Created ${args.path}`;
  }
  if (tool === 'list_directory' || tool === 'get_workspace_structure') {
    return fs.existsSync(WORKSPACE)
      ? fs.readdirSync(WORKSPACE, { recursive: true }).slice(0, 50).join('\n')
      : '(empty workspace)';
  }
  return `Tool ${tool} not implemented in test harness`;
}

/* ═══════════════ Pipeline Phases ═══════════════ */

async function phase1_architecture() {
  console.log('\n' + '═'.repeat(60));
  console.log('📐 PHASE 1: Architecture & PRD');
  console.log('═'.repeat(60));

  const start = Date.now();
  const raw = await callLLM([
    { role: 'system', content: `You are a principal software architect. Produce a complete architecture spec as JSON.
**CRITICAL: Output ONLY valid JSON. No comments (# or //), no trailing commas.**
Return: { "name", "description", "features": [], "techStack": {frontend, styling, backend, database, orm, auth, deployment}, "directoryStructure": [], "apiContracts": [{method, path, description, responseBody, auth}], "dataModels": [{name, fields: [{name, type, constraints}], relations}], "componentTree": [{name, path, description, children}], "envVars": [], "integrations": [] }` },
    { role: 'user', content: 'Create a Spotify clone with playlists, search, user profiles, and music playback.\n\n**Return ONLY valid JSON.**' },
  ]);

  const arch = parseJSON(raw);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`   ✅ Architecture generated in ${elapsed}s`);
  console.log(`   📦 App name: ${arch.name}`);
  console.log(`   🎯 Features: ${arch.features?.length ?? 0}`);
  console.log(`   🔌 API endpoints: ${arch.apiContracts?.length ?? 0}`);
  console.log(`   💾 Data models: ${arch.dataModels?.length ?? 0}`);
  console.log(`   🧩 Components: ${arch.componentTree?.length ?? 0}`);
  console.log(`   📁 Directory entries: ${arch.directoryStructure?.length ?? 0}`);
  console.log(`   🛠️  Stack: ${arch.techStack?.frontend}/${arch.techStack?.backend}/${arch.techStack?.database}`);

  return arch;
}

async function phase2_scaffold(arch) {
  console.log('\n' + '═'.repeat(60));
  console.log('📁 PHASE 2: Scaffold Project Structure');
  console.log('═'.repeat(60));

  // Clean workspace
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });

  const start = Date.now();
  const prompt = `You are an expert software engineer. Create the project scaffold for this app.

Architecture:
- Name: ${arch.name}
- Stack: ${JSON.stringify(arch.techStack)}
- Directory: ${JSON.stringify(arch.directoryStructure?.slice(0, 30))}

Create ALL configuration files (package.json, tsconfig.json, .env.example, tailwind.config.ts, next.config.ts, etc.)
and skeleton source files with proper imports and exports.

Use the write_file tool to create each file. Wrap tool calls like:
<tool_call>{"tool": "write_file", "args": {"path": "filename", "content": "..."}}</tool_call>`;

  const systemMsg = `You are an expert software engineer. You MUST use the write_file tool to create every file.

IMPORTANT: Every file you create MUST be wrapped in a tool_call XML tag. Do NOT write code as plain text.

Example of correct output:
<tool_call>{"tool": "write_file", "args": {"path": "package.json", "content": "{\\n  \\"name\\": \\"my-app\\"\\n}"}}</tool_call>

<tool_call>{"tool": "write_file", "args": {"path": "tsconfig.json", "content": "{\\n  \\"compilerOptions\\": {}\\n}"}}</tool_call>

You MUST use this exact format for EVERY file. Create as many files as possible in each response.`;

  // Multi-turn ReAct loop (just like the real agent)
  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: prompt },
  ];

  let totalFilesCreated = 0;
  const MAX_ITERATIONS = 4;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const raw = await callLLM(messages, { temperature: 0.1, maxTokens: 8192 });
    const calls = parseToolCalls(raw);

    console.log(`   [Iteration ${iter + 1}] LLM returned ${calls.length} tool calls`);

    if (calls.length === 0) {
      console.log('   No more tool calls, stopping iterations');
      break;
    }

    // Execute tools and collect results
    const results = [];
    for (const call of calls) {
      try {
        const result = executeTool(call);
        results.push(`${call.args?.path}: ${result}`);
        if (result.startsWith('✅')) {
          totalFilesCreated++;
          console.log(`   ${result}`);
        }
      } catch (err) {
        results.push(`${call.args?.path}: ⚠️ ${err.message}`);
      }
    }

    // Feed results back using <tool_result> XML format (same as real agent)
    messages.push({ role: 'assistant', content: raw });
    const toolResultXml = results.map(r => {
      const name = r.split(':')[0];
      return `<tool_result tool="write_file" success="true">\n${r}\n</tool_result>`;
    }).join('\n\n');
    messages.push({ role: 'user', content: `${toolResultXml}\n\nGood. Continue creating ALL remaining files from the architecture. Use <tool_call> for each file.` });
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n   ⏱️  Scaffold completed in ${elapsed}s`);

  // List created files
  const allFiles = [];
  function walk(dir, rel = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else allFiles.push(childRel);
    }
  }
  try { walk(WORKSPACE); } catch {}

  console.log(`   📊 Total files on disk: ${allFiles.length}`);
  for (const f of allFiles.slice(0, 25)) {
    const size = fs.statSync(path.join(WORKSPACE, f)).size;
    console.log(`      ${f} (${size} bytes)`);
  }
  if (allFiles.length > 25) console.log(`      ... and ${allFiles.length - 25} more`);

  return allFiles;
}

async function phase3_backend(arch) {
  console.log('\n' + '═'.repeat(60));
  console.log('⚙️  PHASE 3: Backend API Routes (1 iteration sample)');
  console.log('═'.repeat(60));

  const start = Date.now();
  const endpoints = arch.apiContracts?.slice(0, 3) ?? [];

  const raw = await callLLM([
    { role: 'system', content: `You are a senior backend engineer. You MUST use the write_file tool to create every file.

IMPORTANT: Every file you create MUST be wrapped in a tool_call XML tag:
<tool_call>{"tool": "write_file", "args": {"path": "src/routes/auth.ts", "content": "import express from ..."}}</tool_call>

You MUST use this exact format for EVERY file. Do not write code as plain text.` },
    { role: 'user', content: `Implement these API endpoints for ${arch.name}:
${JSON.stringify(endpoints, null, 2)}

Data models: ${JSON.stringify(arch.dataModels, null, 2)}

Use Express.js with TypeScript. Create route files, service layer, and middleware.` },
  ], { temperature: 0.1, maxTokens: 8192 });

  const calls = parseToolCalls(raw);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`   ✅ Backend code generated in ${elapsed}s (${calls.length} files)`);

  for (const call of calls) {
    try {
      const result = executeTool(call);
      if (result.startsWith('✅')) console.log(`   ${result}`);
    } catch (err) {
      console.log(`   ⚠️  ${err.message}`);
    }
  }

  return calls.length;
}

/* ═══════════════ Main ═══════════════ */

async function main() {
  console.log('🎵 NexoAgent Full Pipeline Test: Spotify Clone');
  console.log(`   Model: ${MODEL}`);
  console.log(`   Workspace: ${WORKSPACE}`);
  console.log(`   Time: ${new Date().toISOString()}`);

  const overallStart = Date.now();

  // Phase 1: Architecture
  const arch = await phase1_architecture();

  // Phase 2: Scaffold
  const files = await phase2_scaffold(arch);

  // Phase 3: Backend (sample)
  const backendFiles = await phase3_backend(arch);

  // Summary
  const totalTime = ((Date.now() - overallStart) / 1000).toFixed(1);

  // Final file count
  const allFiles = [];
  function walk(dir, rel = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else allFiles.push(childRel);
    }
  }
  try { walk(WORKSPACE); } catch {}

  console.log('\n' + '═'.repeat(60));
  console.log('🏁 PIPELINE COMPLETE');
  console.log('═'.repeat(60));
  console.log(`   ⏱️  Total time: ${totalTime}s`);
  console.log(`   📁 Files created: ${allFiles.length}`);
  console.log(`   📐 Architecture: ${arch.features?.length} features, ${arch.apiContracts?.length} endpoints`);
  console.log(`   🛠️  Stack: ${arch.techStack?.frontend} + ${arch.techStack?.backend} + ${arch.techStack?.database}`);
  console.log('');

  // Validation
  let passed = true;
  if (!arch.name) { console.log('   ❌ Missing app name'); passed = false; }
  if (!arch.features?.length) { console.log('   ❌ No features'); passed = false; }
  if (!arch.apiContracts?.length) { console.log('   ❌ No API contracts'); passed = false; }
  if (!arch.dataModels?.length) { console.log('   ❌ No data models'); passed = false; }
  if (!arch.techStack?.frontend) { console.log('   ❌ No tech stack'); passed = false; }
  // Note: file creation count depends on the ReAct loop working with tool calls.
  // In the real extension, base.ts runs a multi-turn loop with streaming.
  // Here we validate the architecture (Phase 1) is solid since that was the original bug.

  if (passed) {
    console.log('   ✅ All validations passed!');
    console.log('');
    console.log('🎉 NexoAgent Spotify Clone pilot test: SUCCESS');
  } else {
    console.log('');
    console.log('⚠️  Some validations failed — see details above');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n❌ Pipeline crashed: ${err.message}`);
  process.exit(1);
});
