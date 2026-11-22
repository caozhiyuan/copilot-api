// Antigravity CLI statusline: root + nested subagents.
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

// Cache only numeric counts + child IDs; no conversation text is saved.
function readStats(dir) {
  const file = transcriptOf(dir);
  const children = childrenFromMetadata(dir);
  const blank = { input: 0, cached: 0, created: 0, output: 0, calls: 0, children: [...children] };
  if (!file) return blank;

  let stat;
  try { stat = fs.statSync(file); } catch { return blank; }
  const cacheFile = path.join(CACHE_ROOT, `${path.basename(dir)}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (data.v === 2 && data.file === file && data.size === stat.size &&
        data.mtime === stat.mtimeMs && data.ctime === stat.ctimeMs) {
      return { ...data.stats, children: unique([...children, ...data.stats.children]) };
    }
  } catch {}

  const records = new Map();
  try {
    for (const [lineIndex, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      childrenFromResult(record, children);
      if (record.type !== 'PLANNER_RESPONSE') continue;
      const key = record.step_index ?? `line:${lineIndex}`;
      // Last occurrence wins; preserve earlier usage if a later step omits it.
      const prev = records.get(key) || {};
      records.set(key, { ...prev, ...record,
        input_tokens: record.input_tokens ?? prev.input_tokens,
        cache_read_tokens: record.cache_read_tokens ?? prev.cache_read_tokens,
        cache_creation_input_tokens: record.cache_creation_input_tokens ?? prev.cache_creation_input_tokens,
        output_tokens: record.output_tokens ?? prev.output_tokens });
    }
  } catch { return blank; }

  const stats = { ...blank, children: [...children] };
  for (const r of records.values()) {
    if (![r.input_tokens, r.cache_read_tokens, r.cache_read_input_tokens,
      r.output_tokens].some(v => v != null)) continue;
    stats.input += num(r.input_tokens);
    stats.cached += num(r.cache_read_tokens ?? r.cache_read_input_tokens);
    stats.created += num(r.cache_creation_input_tokens);
    stats.output += num(r.output_tokens);
    stats.calls++;
  }
  try {
    fs.mkdirSync(CACHE_ROOT, { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      v: 2, file, size: stat.size, mtime: stat.mtimeMs,
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
  const { resolve } = createResolver(payload);
  const seen = new Set();
  const totals = { input: 0, cached: 0, created: 0, output: 0, calls: 0, childCount: 0, available: 0 };
  const pending = [rootId];
  while (pending.length && seen.size < MAX_AGENTS + 1) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const dir = resolve(id);
    if (!dir) continue;
    const stats = readStats(dir);
    if (transcriptOf(dir)) totals.available++;
    for (const key of ['input', 'cached', 'created', 'output', 'calls']) {
      totals[key] += stats[key];
    }
    for (const child of stats.children) {
      if (child !== rootId && !seen.has(child)) pending.push(child);
    }
  }
  totals.childCount = Math.max(0, seen.size - 1);
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
  const line1 = `${CYAN}🤖 ${name}${RESET}  ${stateColor}${state}${RESET}` +
    `  ${DIM}SUB ${running} RUN | ${total} FOUND${RESET}`;

  const used = cw.used_percentage == null ? NaN : Number(cw.used_percentage);
  const size = num(cw.context_window_size);
  const shade = used >= 90 ? RED : used >= 70 ? YELLOW : GREEN;
  const line2 = Number.isFinite(used) && size > 0
    ? `${DIM}CTX${RESET} ${shade}${bar(used)}${RESET} ` +
      `${used.toFixed(1)}% ${DIM}(${fmt(used * size / 100)}/${fmt(size)})${RESET}`
    : `${DIM}CTX${RESET} N/A`;

  const latest = cw.current_usage;
  let last = 'LAST N/A';
  if (latest) {
    const prompt = num(latest.input_tokens) + num(latest.cache_read_input_tokens) +
      num(latest.cache_creation_input_tokens);
    if (prompt > 0) last = `LAST ${(num(latest.cache_read_input_tokens) / prompt * 100).toFixed(1)}%`;
  }

  let input = 'N/A', output = 'N/A', session = 'SESSION N/A';
  if (tree && tree.available) {
    // Native transcript input_tokens excludes cache reads.
    const prompt = tree.input + tree.cached + tree.created;
    input = fmt(prompt);
    output = fmt(tree.output);
    if (prompt > 0) session = `SESSION ${(tree.cached / prompt * 100).toFixed(1)}%`;
  }
  const line3 = `${DIM}IN ${input} | OUT ${output}${RESET} | ${last} | ${CYAN}${session}${RESET}`;

  const buckets = Object.entries(s.quota || {}).map(([key, q]) => {
    if (!q) return null;
    if (q.disabled) return `${key}: OFF`;
    if (q.remaining_fraction != null) return `${key}: ${(num(q.remaining_fraction) * 100).toFixed(0)}%`;
    if (q.remaining_amount != null) return `${key}: ${fmt(q.remaining_amount)} left`;
    return null;
  }).filter(Boolean);
  const line4 = buckets.length ? `${DIM}QUOTA${RESET} ${buckets.join(' | ')}` : null;
  return [line1, line2, line3, line4].filter(Boolean).join('\n');
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try { console.log(render(JSON.parse(input))); }
  catch { console.log('Antigravity | statusline unavailable'); }
});
