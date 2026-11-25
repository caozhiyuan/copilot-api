import type { NamespaceTool } from "~/lib/types/responses"

// Function schema: openai/codex rust-v0.171.0-alpha.13.2, multi_agents_spec.rs:236.
export const collaborationReplayTools: NamespaceTool = {
  type: "namespace",
  name: "collaboration",
  description: "Synthetic validation of source-defined collaboration tools.",
  tools: [
    {
      type: "function",
      name: "followup_task",
      description:
        "Send a follow-up task to an existing non-root target agent and trigger a turn if it is idle. If the target is already running, deliver the task promptly at message boundaries while sampling, or after the pending tool call completes.",
      strict: false,
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Agent id or canonical task name to send a follow-up task to (from spawn_agent).",
          },
          message: {
            type: "string",
            description: "Message text to send to the target agent.",
            encrypted: true,
          },
        },
        required: ["target", "message"],
        additionalProperties: false,
      },
    },
  ],
}
