async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input.trim();
}

await readStdin();

const rules = `Prohibited from directly asking questions to users, MUST use AskUserQuestion tool.
Once you can confirm that the task is complete, MUST use AskUserQuestion tool to make user confirm. The user may respond with feedback if they are not satisfied with the result, which you can use to make improvements and try again.

## Subagent Execution Rules

**CRITICAL — This project uses a third-party API proxy (copilot-api). Background agents WILL FAIL with "No task found" errors due to proxy latency causing TaskOutput timeouts.**

### Mandatory Rules
- **NEVER** set \`run_in_background: true\` when spawning agents via the Agent tool
- **ALWAYS** run agents in foreground and wait for their results before proceeding`;

const payload = {
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: rules,
  },
};

process.stdout.write(`${JSON.stringify(payload)}\n`);
