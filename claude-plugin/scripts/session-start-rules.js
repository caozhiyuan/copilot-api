async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input.trim();
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

await readStdin();

const rules = [];

if (isTruthy(process.env.CLAUDE_PLUGIN_ENABLE_QUESTION_RULES)) {
  rules.push(
    "- Prohibited from directly asking questions to users, MUST use question tool.",
    "- Once you can confirm that the task is complete, MUST use question tool to make user confirm. The user may respond with feedback if they are not satisfied with the result, which you can use to make improvements and try again, after try again, MUST use question tool to make user confirm again.",
  );
}

if (isTruthy(process.env.CLAUDE_PLUGIN_ENABLE_NO_BACKGROUND_AGENTS_RULE)) {
  rules.push(
    '- NEVER set `run_in_background: true` on Agent tool - proxy latency causes "No task found" errors. ALWAYS run agents foreground.',
  );
}

const additionalContext = `\n${rules.join("\n")}\n`;

const payload = {
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext,
  },
};

process.stdout.write(`${JSON.stringify(payload)}\n`);
