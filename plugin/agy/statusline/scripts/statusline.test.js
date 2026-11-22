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

function fixtureEnv(dir) {
  return {
    ...process.env,
    GEMINI_HOME: path.join(dir, '.gemini'),
    ANTIGRAVITY_CLI_HOME: '',
    ANTIGRAVITY_BRAIN_DIR: '',
    ANTIGRAVITY_STATUSLINE_CACHE: ''
  };
}

function runStatusline(dir, payload) {
  const result = spawnSync(process.execPath, [statuslineFile], {
    input: JSON.stringify(payload), encoding: 'utf8', env: fixtureEnv(dir)
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.replace(/\x1b\[[\d;]*m/g, '');
}

function writeTranscript(brain, id, records, child) {
  const dir = path.join(brain, id, '.system_generated');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const file = path.join(dir, 'logs', 'transcript_full.jsonl');
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  if (child) {
    fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'subagents', 'first.json'),
      JSON.stringify({ conversationId: child }));
  }
  return file;
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
  for (const invalid of ['{broken json', '[]', 'null']) {
    fs.writeFileSync(config, invalid);
    assert.equal(configure(config, 'node statusline.js', true).status, 'invalid-config');
    assert.equal(fs.readFileSync(config, 'utf8'), invalid);
  }
}));

test('uses the target platform and encodes the Windows script path', () => {
  assert.equal(makeCommand('/tmp/a folder/statusline.js', 'linux', '/usr/bin/node'),
    "'/usr/bin/node' '/tmp/a folder/statusline.js'");
  const file = 'C:\\a folder & (100%)\\copilot-api-statusline\\scripts\\statusline.js';
  const command = makeCommand(file, 'win32');
  const argument = command.split(' ').at(-1);
  assert.match(argument, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(argument, 'base64url').toString('utf8'), file);
  assert.equal(isOurs(command), true);
  assert.equal(isOurs(command + ' extra-argument'), false);
});

test('runs the generated command in a path with spaces and shell characters', () => withTemp(dir => {
  const script = path.join(dir, '状态栏 & team (100%)', 'statusline.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(statuslineFile, script);
  const result = spawnSync(makeCommand(script), {
    shell: true, input: '{}', encoding: 'utf8', env: fixtureEnv(dir), timeout: 5000
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Last request N\/A \| Session N\/A/);
}));

test('migrates commands from the previous installer and a source checkout', () => withTemp(dir => {
  const config = path.join(dir, 'settings.json');
  const command = makeCommand('C:\\new\\copilot-api-statusline\\scripts\\statusline.js', 'win32');
  const oldCommands = [
    'node C:\\old\\copilot-api-statusline\\scripts\\statusline.js',
    'node --import file:///C:/old%20folder/copilot-api-statusline/scripts/statusline.js -e 0',
    makeCommand('/work/copilot-api/plugin/agy/statusline/scripts/statusline.js', 'linux', '/usr/bin/node'),
    makeCommand('C:\\old\\copilot-api-statusline\\scripts\\statusline.js', 'win32')
  ];
  for (const oldCommand of oldCommands) {
    fs.writeFileSync(config, JSON.stringify({ statusLine: { type: 'command', command: oldCommand } }));
    assert.equal(configure(config, command).status, 'configured');
    assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).statusLine.command, command);
    assert.equal(configure(config, command).status, 'unchanged');
  }
}));

test('runs the installer from the checkout with supported arguments', () => withTemp(dir => {
  const install = path.join(__dirname, 'install.js');
  const options = { encoding: 'utf8', env: fixtureEnv(dir) };
  const config = path.join(options.env.GEMINI_HOME, 'antigravity-cli', 'settings.json');
  const obsolete = spawnSync(process.execPath, [install, '--hook'], options);
  assert.equal(obsolete.status, 1);
  assert.equal(fs.existsSync(config), false);
  const setup = spawnSync(process.execPath, [install, '--force'], options);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /^configured:/);
  const repeated = spawnSync(process.execPath, [install], options);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /^unchanged:/);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).statusLine.command, makeCommand());
}));

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
  const output = runStatusline(dir, payload);
  assert.match(output, /SUB 1 RUN \| 2 FOUND/);
  assert.match(output, /^CACHE HIT  Last request 50\.0% \| Session 88\.4%$/m);
  assert.match(output, /IN 1\.2K \| OUT 6/);
  assert.equal(output.trim().split('\n').length, 4);
}));

test('aggregates Workflow agents from task logs and reports without double-counting', () => withTemp(dir => {
  const brain = path.join(dir, '.gemini', 'antigravity-cli', 'brain');
  const root = '11111111-1111-4111-8111-111111111111';
  const taskAgent = '22222222-2222-4222-8222-222222222222';
  const reportAgent = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const nested = '44444444-4444-4444-8444-444444444444';
  const unrelated = '55555555-5555-4555-8555-555555555555';
  const report = (owner, lines) => [
    'Task: ' + owner + '/task-1',
    'Status: RUNNING',
    'Log: file:///task-1.log',
    'Log output:',
    ...lines
  ].join('\r\n');
  const file = writeTranscript(brain, root, [
    { type: 'PLANNER_RESPONSE', input_tokens: 80, cache_read_tokens: 20, output_tokens: 10 },
    { type: 'GENERIC', content: report(root, [
      '- [agent:self] First: running (' + taskAgent + ')',
      '- [agent:research] Second: needs approval (' + reportAgent.toUpperCase() + ')'
    ]) },
    { type: 'GENERIC', content: report(unrelated, ['- [agent:self] Other: running (' + unrelated + ')']) },
    { type: 'GENERIC', content: '- [agent:self] Unrelated output: running (' + unrelated + ')' }
  ], taskAgent);
  writeTranscript(brain, taskAgent,
    [{ type: 'PLANNER_RESPONSE', input_tokens: 25, cache_read_tokens: 75, output_tokens: 20 }], nested);
  writeTranscript(brain, reportAgent,
    [{ type: 'PLANNER_RESPONSE', input_tokens: 50, cache_read_tokens: 50, output_tokens: 30 }]);
  writeTranscript(brain, nested,
    [{ type: 'PLANNER_RESPONSE', input_tokens: 40, cache_read_tokens: 10, output_tokens: 5 }]);
  writeTranscript(brain, unrelated,
    [{ type: 'PLANNER_RESPONSE', input_tokens: 10000, output_tokens: 10000 }]);
  const tasks = path.join(brain, root, '.system_generated', 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, 'task-1.log'), 'x'.repeat(270 * 1024) +
    '\n- [agent:self] Review: core: error (' + taskAgent + '): timed out\n');

  const stat = fs.statSync(file);
  const cache = path.join(dir, '.gemini', 'antigravity-cli', 'statusline-cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, root + '.json'), JSON.stringify({
    v: 3, file, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs,
    stats: { input: 80, cached: 20, created: 0, output: 10, calls: 1, children: [taskAgent] }
  }));

  const payload = { conversation_id: root };
  const output = runStatusline(dir, payload);
  assert.match(output, /SUB 0 RUN \| 1 FOUND \| WORKFLOW AGENTS 2/);
  assert.match(output, /IN 350 \| OUT 65\r?\nCACHE HIT  Last request N\/A \| Session 44\.3%/);
  assert.equal(runStatusline(dir, payload), output);
}));

test('updates the Workflow count and usage as task and child logs arrive', () => withTemp(dir => {
  const brain = path.join(dir, '.gemini', 'antigravity-cli', 'brain');
  const root = '11111111-1111-4111-8111-111111111111';
  const child = '22222222-2222-4222-8222-222222222222';
  const payload = { conversation_id: root };
  writeTranscript(brain, root, [{ type: 'PLANNER_RESPONSE', input_tokens: 10, output_tokens: 1 }]);
  assert.doesNotMatch(runStatusline(dir, payload), /WORKFLOW AGENTS/);

  const tasks = path.join(brain, root, '.system_generated', 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, 'task-2.log'), '- [phase] Review\n- [agent:self] Reviewer: running (' + child + ')\n');
  const beforeUsage = runStatusline(dir, payload);
  assert.match(beforeUsage, /WORKFLOW AGENTS 1/);
  assert.match(beforeUsage, /IN 10 \| OUT 1/);

  writeTranscript(brain, child,
    [{ type: 'PLANNER_RESPONSE', input_tokens: 10, cache_read_tokens: 20, output_tokens: 2 }]);
  const afterUsage = runStatusline(dir, payload);
  assert.match(afterUsage, /WORKFLOW AGENTS 1/);
  assert.match(afterUsage, /IN 40 \| OUT 3\r?\nCACHE HIT  Last request N\/A \| Session 50\.0%/);
}));

test('session totals stay unavailable until a transcript contains usage', () => withTemp(dir => {
  const brain = path.join(dir, '.gemini', 'antigravity', 'brain');
  const id = '11111111-1111-4111-8111-111111111111';
  const payload = { conversation_id: id };
  const missingUsage = /IN N\/A \| OUT N\/A\r?\nCACHE HIT  Last request N\/A \| Session N\/A/;
  assert.match(runStatusline(dir, payload), missingUsage);
  writeTranscript(brain, id, [{ type: 'PLANNER_RESPONSE', step_index: 0 }]);
  assert.match(runStatusline(dir, payload), missingUsage);
  writeTranscript(brain, id, [
    { type: 'PLANNER_RESPONSE', step_index: 0, cache_creation_input_tokens: 1024 }
  ]);
  assert.match(runStatusline(dir, payload), /IN 1\.0K \| OUT 0\r?\nCACHE HIT  Last request N\/A \| Session 0\.0%/);
}));

test('preserves cache counts across aliases and rebuilds old cached results', () => withTemp(dir => {
  const brain = path.join(dir, '.gemini', 'antigravity', 'brain');
  const id = '11111111-1111-4111-8111-111111111111';
  const file = writeTranscript(brain, id, [
    { type: 'PLANNER_RESPONSE', step_index: 0, input_tokens: 100, cache_read_tokens: 400 },
    { type: 'PLANNER_RESPONSE', step_index: 0, cache_read_input_tokens: 900 },
    { type: 'PLANNER_RESPONSE', step_index: 0, cache_read_input_tokens: null, output_tokens: 12 }
  ]);
  const stat = fs.statSync(file);
  const cache = path.join(dir, '.gemini', 'antigravity-cli', 'statusline-cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, id + '.json'), JSON.stringify({
    v: 2, file, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs,
    stats: { input: 100, cached: 400, created: 0, output: 12, calls: 1, children: [] }
  }));
  const payload = { conversation_id: id };
  const output = runStatusline(dir, payload);
  assert.match(output, /IN 1\.0K \| OUT 12\r?\nCACHE HIT  Last request N\/A \| Session 90\.0%/);
  assert.equal(runStatusline(dir, payload), output);
}));

test('empty statusLine placeholders are auto-configured without --force', () => withTemp(dir => {
  const config = path.join(dir, 'settings.json');
  const command = '/usr/bin/node /some/copilot-api-statusline/scripts/statusline.js';
  for (const existing of [
    { type: '', command: '', enabled: true },
    { type: 'command', command: '  ', enabled: true },
    { type: '', enabled: true }
  ]) {
    fs.writeFileSync(config, JSON.stringify({
      altScreenMode: 'always', trustedWorkspaces: ['D:\\bud\\copilot-api'],
      statusLine: existing
    }));
    assert.equal(configure(config, command).status, 'configured');
    const updated = JSON.parse(fs.readFileSync(config, 'utf8'));
    assert.equal(updated.statusLine.type, 'command');
    assert.equal(updated.statusLine.command, command);
    assert.equal(updated.statusLine.enabled, true);
    assert.equal(updated.altScreenMode, 'always');
    assert.deepEqual(updated.trustedWorkspaces, ['D:\\bud\\copilot-api']);
  }
}));

test('explicitly disabled statusLine is preserved unless forced', () => withTemp(dir => {
  const config = path.join(dir, 'settings.json');
  fs.writeFileSync(config, JSON.stringify({ statusLine: { command: '', enabled: false } }));
  assert.equal(configure(config, 'node statusline.js').status, 'skipped-disabled');
  assert.equal(configure(config, 'node statusline.js', true).status, 'configured');
}));
