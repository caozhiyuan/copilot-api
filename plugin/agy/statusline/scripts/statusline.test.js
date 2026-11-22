const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { configure, makeCommand, isOurs } = require('./install.js');

const statuslineFile = path.join(__dirname, 'statusline.js');

function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-statusline-test-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function writeTranscript(brain, id, records, child) {
  const dir = path.join(brain, id, '.system_generated');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'transcript_full.jsonl'),
    records.map(r => JSON.stringify(r)).join('\n') + '\n');
  if (child) {
    fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'subagents', 'first.json'),
      JSON.stringify({ conversationId: child }));
  }
}

test('preserves unrelated settings and does not replace foreign statuslines', () => withTemp(dir => {
  const config = path.join(dir, 'settings.json');
  const cmd = '/usr/bin/node /some/copilot-api-statusline/scripts/statusline.js';
  fs.writeFileSync(config, JSON.stringify({ ui: { theme: 'dark' }, statusLine: { command: 'other' } }));
  assert.equal(configure(config, cmd).status, 'skipped-existing');
  assert.equal(JSON.parse(fs.readFileSync(config)).statusLine.command, 'other');
  assert.equal(configure(config, cmd, true).status, 'configured');
  const updated = JSON.parse(fs.readFileSync(config));
  assert.deepEqual(updated.ui, { theme: 'dark' });
  assert.equal(updated.statusLine.command, cmd);
  assert.equal(configure(config, cmd).status, 'unchanged');
  assert.equal(isOurs(cmd), true);
  assert.equal(isOurs('node /foreign/statusline.js'), false);
}));

test('invalid settings are never overwritten', () => withTemp(dir => {
  const config = path.join(dir, 'settings.json');
  fs.writeFileSync(config, '{broken json');
  assert.equal(configure(config, 'node statusline.js', true).status, 'invalid-config');
  assert.equal(fs.readFileSync(config, 'utf8'), '{broken json');
}));

test('cross-platform command shape', () => {
  assert.match(makeCommand('/tmp/a folder/statusline.js', 'linux', '/usr/bin/node'), /'\/tmp\/a folder\/statusline\.js'/);
  const win = makeCommand('/tmp/a folder/statusline.js', 'win32');
  assert.match(win, /node --import file:\/\/\//);
  assert.ok(!win.includes('"'));
});

test('recursive nested subagents, token stats and deduplication', () => withTemp(dir => {
  const brain = path.join(dir, '.gemini', 'antigravity', 'brain');
  const root = '11111111-1111-4111-8111-111111111111';
  const child = '22222222-2222-4222-8222-222222222222';
  const nested = '33333333-3333-4333-8333-333333333333';
  writeTranscript(brain, root, [
    { type: 'PLANNER_RESPONSE', step_index: 0, input_tokens: 100, cache_read_tokens: 900, cache_creation_input_tokens: 10, output_tokens: 1 },
    { type: 'INVOKE_SUBAGENT', content: JSON.stringify({ conversationId: child }) },
    { type: 'PLANNER_RESPONSE', step_index: 0, output_tokens: 1 }
  ], child);
  writeTranscript(brain, child, [
    { type: 'PLANNER_RESPONSE', step_index: 1, input_tokens: 20, cache_read_tokens: 80, output_tokens: 2 },
    { type: 'INVOKE_SUBAGENT', content: 'Result: brain/' + nested + '/summary' }
  ], nested);
  writeTranscript(brain, nested, [
    { type: 'PLANNER_RESPONSE', step_index: 2, input_tokens: 10, cache_read_tokens: 90, output_tokens: 3 }
  ]);
  const payload = {
    conversation_id: root,
    transcript_path: path.join(brain, root, '.system_generated', 'logs', 'transcript.jsonl'),
    model: { display_name: 'Gemini' },
    agent_state: 'working',
    subagents: [{ status: 'running' }],
    context_window: {
      used_percentage: 15, context_window_size: 1000,
      current_usage: { input_tokens: 50, cache_read_input_tokens: 50 }
    }
  };
  const result = spawnSync(process.execPath, [statuslineFile], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, GEMINI_HOME: path.join(dir, '.gemini') }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout.replace(/\x1b\[[\d;]*m/g, '');
  assert.match(output, /SUB 1 RUN \| 2 FOUND/);
  assert.match(output, /LAST 50\.0%/);
  assert.match(output, /SESSION 88\.4%/);
  assert.match(output, /IN 1\.2K \| OUT 6/);
  assert.equal(output.trim().split('\n').length, 3);
}));

test('missing transcript shows N/A rather than fabricated session cache', () => withTemp(dir => {
  const result = spawnSync(process.execPath, [statuslineFile], {
    input: JSON.stringify({ conversation_id: '11111111-1111-4111-8111-111111111111' }),
    encoding: 'utf8', env: { ...process.env, GEMINI_HOME: path.join(dir, '.gemini') }
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /SESSION N\/A/);
}));
