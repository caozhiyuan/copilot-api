async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input.trim();
}

const rawInput = await readStdin();
let hookInput = {};

if (rawInput) {
  try {
    hookInput = JSON.parse(rawInput);
  } catch {
    hookInput = {};
  }
}

const marker = `__SUBAGENT_MARKER__${JSON.stringify({
  session_id: hookInput.session_id ?? null,
  agent_id: hookInput.agent_id ?? null,
  agent_type: hookInput.agent_type ?? null,
})}`;

const payload = {
  hookSpecificOutput: {
    hookEventName: "SubagentStart",
    additionalContext: marker,
  },
};

process.stdout.write(`${JSON.stringify(payload)}\n`);
