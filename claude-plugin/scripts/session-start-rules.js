async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input.trim();
}

await readStdin();

const rules = `MUST use AskUserQuestion tool (never ask users directly). Confirm task completion via AskUserQuestion.
NEVER set \`run_in_background: true\` on Agent tool — proxy latency causes "No task found" errors. ALWAYS run agents foreground.`;

const payload = {
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: rules,
  },
};

process.stdout.write(`${JSON.stringify(payload)}\n`);
