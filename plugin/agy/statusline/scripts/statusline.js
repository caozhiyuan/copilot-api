// Antigravity CLI statusline with subagent and Workflow usage.
// Cross-platform: Windows, macOS, and Linux (Node.js built-ins only).
// No npm dependencies. Read-only access to Antigravity transcripts.
// Optional path overrides: GEMINI_HOME, ANTIGRAVITY_CLI_HOME,
// ANTIGRAVITY_BRAIN_DIR, ANTIGRAVITY_STATUSLINE_CACHE.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AGENTS = 200;
const TASK_LOG_TAIL_BYTES = 256 * 1024;
const CACHE_VERSION = 4;

// Override these when Antigravity stores its data outside the default location.
// All paths are resolved with Node's platform-native path implementation.
const GEMINI_HOME = process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini');
const CLI_HOME = process.env.ANTIGRAVITY_CLI_HOME || path.join(GEMINI_HOME, 'antigravity-cli');
const CACHE_ROOT = process.env.ANTIGRAVITY_STATUSLINE_CACHE ||
  path.join(CLI_HOME, 'statusline-cache');

const num = v => Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0;
const fmt = v => {
  const n = num(v);
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n));
};
const bar = (v, width = 14) => {
  const filled = Math.round(Math.max(0, Math.min(100, v)) * width / 100);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
};
const exists = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const directory = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const unique = values => [...new Set(values.filter(Boolean))];

// Prefer the authoritative complete transcript. Never read both versions.
function transcriptOf(dir) {
  const logs = path.join(dir, '.system_generated', 'logs');
  for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const file = path.join(logs, name);
    if (exists(file)) return file;
  }
  return null;
}

function createResolver(payload) {
  const id = payload.conversation_id || payload.session_id;
  const supplied = payload.transcript_path && path.resolve(payload.transcript_path);
  const suppliedDir = supplied && path.dirname(path.dirname(path.dirname(supplied)));
  const roots = unique([
    process.env.ANTIGRAVITY_BRAIN_DIR,
    suppliedDir && path.dirname(suppliedDir),
    path.join(CLI_HOME, 'brain'),
    path.join(GEMINI_HOME, 'antigravity', 'brain')
  ]);
  const cache = new Map();
  function resolve(conversationId) {
    if (!UUID.test(String(conversationId))) return null;
    if (cache.has(conversationId)) return cache.get(conversationId);
    let dir = null;
    for (const root of roots) {
      const candidate = path.join(root, conversationId);
      if (directory(candidate)) { dir = candidate; break; }
    }
    // Prefer the precise path from CLI, even if its directory is not discoverable yet.
    if (!dir && conversationId === id && suppliedDir && directory(suppliedDir)) {
      dir = suppliedDir;
    }
    cache.set(conversationId, dir);
    return dir;
  }
  return { resolve };
}

// Find child IDs in explicit metadata; fall back to INVOKE_SUBAGENT results.
function childrenFromMetadata(dir) {
  const folder = path.join(dir, '.system_generated', 'subagents');
  const ids = new Set();
  try {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const fromName = entry.name.slice(0, -5);
      if (UUID.test(fromName)) { ids.add(fromName); continue; }
      try {
        const data = JSON.parse(fs.readFileSync(path.join(folder, entry.name), 'utf8'));
        for (const v of [data.conversationId, data.conversation_id, data.childId, data.child_id]) {
          if (UUID.test(String(v))) ids.add(v);
        }
      } catch {}
    }
  } catch {}
  return ids;
}

function childrenFromResult(record, ids) {
  if (record.type !== 'INVOKE_SUBAGENT') return;
  const source = [record.content, record.tool_calls]
    .filter(Boolean)
    .map(v => typeof v === 'string' ? v : JSON.stringify(v)).join('\n');
  // Some versions embed JSON objects directly in the prose result.
  const byField = /\\?["']conversationId\\?["']\s*:\s*\\?["']([0-9a-f-]{36})/gi;
  const byPath = /(?:brain[\\/])([0-9a-f-]{36})[\\/]/gi;
  for (const re of [byField, byPath]) {
    for (const match of source.matchAll(re)) {
      if (UUID.test(match[1])) ids.add(match[1]);
    }
  }
}

function collectWorkflowAgents(text, ids) {
  const agentRow = /^[ \t]*- \[agent:[^\]\r\n]+\] [^\r\n]*?:[ \t]+[a-z][a-z _-]*[ \t]+\(([a-f0-9-]{36})\)(?::[^\r\n]*)?[ \t]*\r?$/gim;
  for (const [, id] of text.matchAll(agentRow)) {
    if (UUID.test(id)) ids.add(id.toLowerCase());
  }
}

function workflowAgentsFromTasks(dir) {
  const tasks = path.join(dir, '.system_generated', 'tasks');
  const ids = new Set();
  let entries;
  try { entries = fs.readdirSync(tasks, { withFileTypes: true }); } catch { return ids; }
  for (const entry of entries) {
    if (!entry.isFile() || !/^task-\d+\.log$/.test(entry.name)) continue;
    try {
      const fd = fs.openSync(path.join(tasks, entry.name), 'r');
      try {
        // Task logs also contain shell output. Read a bounded tail for the agent rows.
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, TASK_LOG_TAIL_BYTES);
        const bytes = Buffer.alloc(length);
        const read = fs.readSync(fd, bytes, 0, length, size - length);
        collectWorkflowAgents(bytes.toString('utf8', 0, read), ids);
      } finally {
        fs.closeSync(fd);
      }
    } catch {} // AGY may replace a task log while it is running.
  }
  return ids;
}

function workflowAgentsFromReport(record, conversationId, ids) {
  if (record.type !== 'GENERIC' || typeof record.content !== 'string') return;
  const report = /^Task: ([a-f0-9-]{36})\/task-\d+\r?\nStatus: [^\r\n]+\r?\nLog: [^\r\n]+\r?\nLog output:\r?$/im.exec(record.content);
  if (report?.[1].toLowerCase() === conversationId) {
    collectWorkflowAgents(record.content.slice(report.index + report[0].length), ids);
  }
}

// Cache only numeric counts + child IDs; no conversation text is saved.
function readStats(dir) {
  const file = transcriptOf(dir);
  const children = childrenFromMetadata(dir);
  const blank = { input: 0, cached: 0, created: 0, output: 0, calls: 0, children: [...children], workflowAgents: [] };
  if (!file) return blank;

  let stat;
  try { stat = fs.statSync(file); } catch { return blank; }
  const conversationId = path.basename(dir).toLowerCase();
  const cacheFile = path.join(CACHE_ROOT, `${path.basename(dir)}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (data.v === CACHE_VERSION && data.file === file && data.size === stat.size &&
        data.mtime === stat.mtimeMs && data.ctime === stat.ctimeMs &&
        Array.isArray(data.stats?.workflowAgents)) {
      return { ...data.stats, children: unique([...children, ...data.stats.children]) };
    }
  } catch {}

  const records = new Map();
  const workflowAgents = new Set();
  try {
    for (const [lineIndex, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || typeof record !== 'object') continue;
      childrenFromResult(record, children);
      workflowAgentsFromReport(record, conversationId, workflowAgents);
      if (record.type !== 'PLANNER_RESPONSE') continue;
      const key = record.step_index ?? `line:${lineIndex}`;
      // Last occurrence wins; preserve earlier usage if a later step omits it.
      const prev = records.get(key);
      records.set(key, {
        input: record.input_tokens ?? prev?.input,
        cached: record.cache_read_tokens ?? record.cache_read_input_tokens ?? prev?.cached,
        created: record.cache_creation_input_tokens ?? prev?.created,
        output: record.output_tokens ?? prev?.output
      });
    }
  } catch { return blank; }

  const stats = { ...blank, children: [...children], workflowAgents: [...workflowAgents] };
  for (const usage of records.values()) {
    if (![usage.input, usage.cached, usage.created, usage.output].some(v => v != null)) continue;
    stats.input += num(usage.input);
    stats.cached += num(usage.cached);
    stats.created += num(usage.created);
    stats.output += num(usage.output);
    stats.calls++;
  }
  try {
    fs.mkdirSync(CACHE_ROOT, { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      v: CACHE_VERSION, file, size: stat.size, mtime: stat.mtimeMs,
      ctime: stat.ctimeMs, stats
    }));
    try { fs.renameSync(tmp, cacheFile); }
    catch { try { fs.unlinkSync(tmp); } catch {} }
  } catch {} // Statusline must not fail because caching failed.
  return stats;
}

function sessionTree(payload) {
  const rootId = payload.conversation_id || payload.session_id;
  if (!UUID.test(String(rootId))) return null;
  const rootKey = String(rootId).toLowerCase();
  const { resolve } = createResolver(payload);
  const seen = new Set();
  const workflowAgents = new Set();
  const totals = { input: 0, cached: 0, created: 0, output: 0, calls: 0, childCount: 0, workflowCount: 0 };
  const pending = [rootId];
  while (pending.length && seen.size < MAX_AGENTS + 1) {
    const id = pending.pop();
    const key = String(id).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const dir = resolve(id);
    if (!dir) continue;
    const stats = readStats(dir);
    for (const key of ['input', 'cached', 'created', 'output', 'calls']) {
      totals[key] += stats[key];
    }
    const workflows = new Set([...stats.workflowAgents, ...workflowAgentsFromTasks(dir)]);
    for (const child of workflows) {
      if (child !== key && child !== rootKey) workflowAgents.add(child);
    }
    for (const child of [...stats.children, ...workflows]) {
      if (!seen.has(String(child).toLowerCase())) pending.push(child);
    }
  }
  totals.workflowCount = [...workflowAgents].filter(id => seen.has(id)).length;
  totals.childCount = seen.size - 1 - totals.workflowCount;
  return totals;
}

function render(s) {
  const cw = s.context_window || {};
  const model = s.model?.display_name || 'Unknown';
  const effort = s.model?.effort;
  const name = effort && !model.toLowerCase().includes(`(${String(effort).toLowerCase()})`)
    ? `${model} (${effort})` : model;
  const state = String(s.agent_state || 'idle').toUpperCase();
  const stateColor = state === 'ERROR' ? RED
    : ['WORKING', 'TOOL_USE', 'REVIEWING'].includes(state) ? GREEN : YELLOW;
  const tree = sessionTree(s);

  const live = Array.isArray(s.subagents) ? s.subagents : [];
  const running = live.filter(a => String(a?.status).toLowerCase() === 'running').length;
  const total = Math.max(live.length, tree?.childCount || 0);
  const workflows = tree?.workflowCount ? ` | WORKFLOW AGENTS ${tree.workflowCount}` : '';
  const line1 = `${CYAN}🤖 ${name}${RESET}  ${stateColor}${state}${RESET}` +
    `  ${DIM}SUB ${running} RUN | ${total} FOUND${workflows}${RESET}`;

  const used = cw.used_percentage == null ? NaN : Number(cw.used_percentage);
  const size = num(cw.context_window_size);
  const shade = used >= 90 ? RED : used >= 70 ? YELLOW : GREEN;
  const line2 = Number.isFinite(used) && size > 0
    ? `${DIM}CTX${RESET} ${shade}${bar(used)}${RESET} ` +
      `${used.toFixed(1)}% ${DIM}(${fmt(used * size / 100)}/${fmt(size)})${RESET}`
    : `${DIM}CTX${RESET} N/A`;

  const latest = cw.current_usage;
  let lastHit = 'N/A';
  if (latest) {
    const prompt = num(latest.input_tokens) + num(latest.cache_read_input_tokens) +
      num(latest.cache_creation_input_tokens);
    if (prompt > 0) lastHit = `${(num(latest.cache_read_input_tokens) / prompt * 100).toFixed(1)}%`;
  }

  let input = 'N/A', output = 'N/A', sessionHit = 'N/A';
  if (tree?.calls) {
    // Native transcript input_tokens excludes cache reads.
    const prompt = tree.input + tree.cached + tree.created;
    input = fmt(prompt);
    output = fmt(tree.output);
    if (prompt > 0) sessionHit = `${(tree.cached / prompt * 100).toFixed(1)}%`;
  }
  const tokens = `${DIM}IN ${input} | OUT ${output}${RESET}`;
  const cacheHit = `${CYAN}CACHE HIT${RESET}  Last request ${lastHit} | Session ${sessionHit}`;

  const buckets = Object.entries(s.quota || {}).map(([key, q]) => {
    if (!q) return null;
    if (q.disabled) return `${key}: OFF`;
    if (q.remaining_fraction != null) return `${key}: ${(num(q.remaining_fraction) * 100).toFixed(0)}%`;
    if (q.remaining_amount != null) return `${key}: ${fmt(q.remaining_amount)} left`;
    return null;
  }).filter(Boolean);
  const quota = buckets.length ? `${DIM}QUOTA${RESET} ${buckets.join(' | ')}` : null;
  return [line1, line2, tokens, cacheHit, quota].filter(Boolean).join('\n');
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try { console.log(render(JSON.parse(input))); }
  catch { console.log('Antigravity | statusline unavailable'); }
});
