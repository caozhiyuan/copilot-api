// Configure the AGY statusline command in the user's settings.
// An existing foreign statusline is never replaced unless --force is passed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const pluginScript = path.join(__dirname, 'statusline.js');
const configFile = path.join(
  process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini'),
  'antigravity-cli', 'settings.json'
);

// Give cmd.exe only a fixed loader and a path argument containing shell-safe characters.
const windowsLoader = [
  'import { pathToFileURL } from "node:url";',
  'const file = Buffer.from(process.argv[1], "base64url").toString("utf8");',
  'await import(pathToFileURL(file));'
].join('\n');
const windowsCommand = 'node --import=data:text/javascript;base64,' +
  Buffer.from(windowsLoader).toString('base64') + ' -e 0 -- ';
const pluginScriptPath =
  /(?:^|[\\/])(?:copilot-api-statusline|copilot-api[\\/]plugin[\\/]agy[\\/]statusline)[\\/]scripts[\\/]statusline\.js$/i;

function quotePosix(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function makeCommand(file = pluginScript, platform = process.platform, node = process.execPath) {
  if (platform === 'win32') {
    return windowsCommand + Buffer.from(path.win32.resolve(file)).toString('base64url');
  }
  return quotePosix(node) + ' ' + quotePosix(path.posix.resolve(file));
}

function isOurs(command) {
  if (typeof command !== 'string') return false;
  if (command.startsWith(windowsCommand)) {
    const argument = command.slice(windowsCommand.length);
    return /^[A-Za-z0-9_-]+$/.test(argument) &&
      pluginScriptPath.test(Buffer.from(argument, 'base64url').toString('utf8'));
  }
  // Match commands written by the earlier POSIX and Windows installers.
  return pluginScriptPath.test(command.trimEnd().replace(/(?: -e 0|['"])$/, ''));
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
      if (existing.command === command && existing.type === 'command') {
        return { status: 'unchanged' };
      }
      if (!isOurs(existing.command)) return { status: 'skipped-existing' };
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
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--force')) {
      throw new Error('Usage: node ./scripts/install.js [--force]');
    }
    const result = configure(configFile, makeCommand(), args.includes('--force'));
    console.log(result.status + ': ' + configFile);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { configure, makeCommand, isOurs };
