// Register this plugin's local-only statusline at the first AGY SessionStart.
// An existing foreign statusline is never replaced unless --force is passed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const pluginScript = path.join(__dirname, 'statusline.js');
const configFile = path.join(
  process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini'),
  'antigravity-cli', 'settings.json'
);

function quotePosix(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function makeCommand(file = pluginScript, platform = process.platform, node = process.execPath) {
  if (platform === 'win32') {
    // AGY uses cmd /c on Windows. Avoid nested quotes when paths contain spaces.
    const full = path.resolve(file);
    return full.includes(' ')
      ? 'node --import ' + pathToFileURL(full).href + ' -e 0'
      : 'node ' + full;
  }
  return quotePosix(node) + ' ' + quotePosix(path.resolve(file));
}

function isOurs(command) {
  return typeof command === 'string' &&
    /(?:^|[\\/])copilot-api-statusline[\\/]scripts[\\/]statusline\.js\b/i
      .test(command.replace(/%20/g, ' '));
}

function configure(file = configFile, command = makeCommand(), force = false) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!current || Array.isArray(current) || typeof current !== 'object') {
      return { status: 'invalid-config' };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') return { status: 'invalid-config' };
  }

  const existing = current.statusLine;
  if (existing != null && !force) {
    if (typeof existing !== 'object' || Array.isArray(existing)) {
      return { status: 'skipped-existing' };
    }
    if (existing.enabled === false) return { status: 'skipped-disabled' };
    // An empty command is an unconfigured placeholder, not a custom statusline.
    if (typeof existing.command === 'string' && existing.command.trim()) {
      if (!isOurs(existing.command)) return { status: 'skipped-existing' };
      if (existing.command === command && existing.type === 'command') {
        return { status: 'unchanged' };
      }
    }
  }

  current.statusLine = {
    ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}),
    type: 'command',
    command,
    enabled: true,
    padding: 0,
    stack_with_default: false
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  return { status: 'configured' };
}

if (require.main === module) {
  const hook = process.argv.includes('--hook');
  try {
    const result = configure(configFile, makeCommand(), process.argv.includes('--force'));
    if (hook) {
      // SessionStart hooks must emit a JSON object, not model-facing text.
      process.stdout.write('{}\n');
    } else {
      console.log(result.status + ': ' + configFile);
    }
  } catch (err) {
    if (hook) {
      process.stdout.write('{}\n');
    } else {
      console.error(err.message);
      process.exitCode = 1;
    }
  }
}

module.exports = { configure, makeCommand, isOurs };
