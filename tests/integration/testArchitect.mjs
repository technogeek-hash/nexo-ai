#!/usr/bin/env node
/**
 * Integration test: calls the NVIDIA API with the architect prompt
 * and verifies the JSON parsing pipeline handles the response correctly.
 * 
 * Usage: node tests/integration/testArchitect.mjs
 */

const API_KEY = process.env.NVIDIA_API_KEY;
const BASE_URL = 'https://integrate.api.nvidia.com/v1';
const MODEL = 'nvidia/llama-3.3-nemotron-super-49b-v1';

if (!API_KEY) {
  console.error('❌ Set NVIDIA_API_KEY environment variable first');
  process.exit(1);
}

/* ─── The same stripJsonComments logic from appOrchestrator.ts ─── */
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

function parseArchitectureResponse(raw) {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  }
  cleaned = stripJsonComments(cleaned);
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(cleaned);
  } catch (firstErr) {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        let extracted = stripJsonComments(jsonMatch[0]);
        extracted = extracted.replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(extracted);
      } catch { /* fall through */ }
    }
    throw new Error(`Failed to parse architecture response: ${firstErr.message}\n\nRaw (first 500 chars):\n${raw.slice(0, 500)}`);
  }
}

/* ─── Architect system prompt (abridged) ─── */
const systemPrompt = `You are a principal software architect. Given a high-level app description, produce a complete architecture specification as JSON.

**CRITICAL: Output ONLY valid JSON. Do NOT include comments (no # or // comments). Do NOT include trailing commas. The output will be parsed by JSON.parse() directly.**

Return this exact structure:
{
  "name": "app-name",
  "description": "...",
  "features": ["..."],
  "techStack": { "frontend": "next", "styling": "tailwind", "backend": "express", "database": "postgresql", "orm": "prisma", "auth": "nextauth", "deployment": "docker" },
  "directoryStructure": ["src/app/layout.tsx", "src/app/page.tsx"],
  "apiContracts": [{ "method": "GET", "path": "/api/items", "description": "...", "responseBody": "Item[]", "auth": true }],
  "dataModels": [{ "name": "User", "fields": [{ "name": "id", "type": "uuid", "constraints": "PK" }], "relations": ["has many Posts"] }],
  "componentTree": [{ "name": "Layout", "path": "src/app/layout.tsx", "description": "Root layout", "children": ["Navbar"] }],
  "envVars": ["DATABASE_URL=postgresql://..."],
  "integrations": ["Stripe for payments"]
}`;

/* ─── Call the API ─── */
async function main() {
  console.log('🚀 Testing architect pipeline: "Create a Spotify clone"');
  console.log(`   Model: ${MODEL}`);
  console.log(`   API: ${BASE_URL}`);
  console.log('');

  const startTime = Date.now();

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Create a Spotify clone with playlists, search, user profiles, and music playback.\n\n**IMPORTANT: Return ONLY valid JSON. No comments (# or //), no trailing commas.**' },
      ],
      temperature: 0.2,
      max_tokens: 8192,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`❌ API returned ${res.status}: ${body.slice(0, 500)}`);
    process.exit(1);
  }

  const json = await res.json();
  const raw = json.choices?.[0]?.message?.content;
  const elapsed = Date.now() - startTime;

  if (!raw) {
    console.error('❌ No content in API response');
    console.error(JSON.stringify(json, null, 2).slice(0, 1000));
    process.exit(1);
  }

  console.log(`✅ API responded in ${(elapsed / 1000).toFixed(1)}s (${raw.length} chars)`);
  console.log('');

  // Check for comments in raw response
  const hasHashComments = /#\s/.test(raw.replace(/"[^"]*"/g, ''));
  const hasSlashComments = /\/\/\s/.test(raw.replace(/"[^"]*"/g, ''));
  if (hasHashComments) console.log('⚠️  LLM included # comments (will be stripped)');
  if (hasSlashComments) console.log('⚠️  LLM included // comments (will be stripped)');

  // Parse with our pipeline
  try {
    const arch = parseArchitectureResponse(raw);
    console.log('✅ JSON parse SUCCESS');
    console.log('');
    console.log('📐 Architecture Summary:');
    console.log(`   Name: ${arch.name}`);
    console.log(`   Description: ${arch.description?.slice(0, 100)}...`);
    console.log(`   Features: ${arch.features?.length ?? 0}`);
    console.log(`   API endpoints: ${arch.apiContracts?.length ?? 0}`);
    console.log(`   Data models: ${arch.dataModels?.length ?? 0}`);
    console.log(`   Components: ${arch.componentTree?.length ?? 0}`);
    console.log(`   Directory entries: ${arch.directoryStructure?.length ?? 0}`);
    console.log(`   Tech stack: ${JSON.stringify(arch.techStack)}`);
    console.log('');
    console.log('🎉 All checks passed!');
  } catch (err) {
    console.error(`❌ JSON parse FAILED: ${err.message}`);
    console.error('');
    console.error('Raw response (first 1000 chars):');
    console.error(raw.slice(0, 1000));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
