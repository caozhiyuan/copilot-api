# Copilot collaboration compatibility

`copilotResponsesCompatibilityModels` opts exact model IDs into a compatibility mode on the native Copilot `/v1/responses` route. It defaults to an empty list. Provider aliases, the built-in Codex provider, and Messages/Chat routes do not use this mode.

```json
{
  "copilotResponsesCompatibilityModels": ["gpt-6-astra"]
}
```

Restart the server after editing the configuration file. Remove the model from the list to disable the mode. No model wildcard matching is performed.

## Collaboration tools

Some Copilot upstreams cannot replay native encrypted collaboration message arguments. Changing the encryption flags on the original tools is also rejected because the `collaboration` schemas are reserved.

The adapter forwards these tools under an ordinary namespace, removes the encryption annotations on `spawn_agent.message`, `send_message.message`, and `followup_task.message`, and restores the client's tool names on the response. New subagent messages are plain-text strings, including when the client saves and replays them. This applies to both streaming and nonstreaming results and HTTP/WebSocket transport selection.

Tool definitions in both `tools` and Responses Lite `input.additional_tools` are supported, along with replayed calls, discovered tool definitions, and explicit tool choices. Namespace selection avoids collisions with other declared or replayed tools. Arguments, call IDs, user text, reasoning ciphertext, and other tool namespaces are not rewritten.

Codex v2 still labels these delegated strings as `encrypted_content` in a child's `agent_message`. Before delivering a completed collaboration call, the gateway records SHA-256 hashes of its plain-text message arguments in the existing SQLite database (`COPILOT_API_SQLITE_DB_PATH`, or `copilot-api.sqlite` in the data directory). When a subsequent agent message matches one of these hashes, the gateway changes that content part to `input_text` and preserves the exact string. It does not guess from the appearance of the text and does not store message bodies in this table.

Preserve this SQLite metadata along with the gateway's data when restarting or migrating it. Sessions must return to an instance with the metadata, or use a shared data store. Enable the mode for each model used by the affected parent and child threads. Storage is initialized before starting a request that can emit compatibility tool calls, and hashes are persisted before completed arguments/calls are delivered to the client.

This does not decrypt existing conversation content. Opaque history is retained unchanged; a session or child thread with unreadable encrypted messages may still require explicit recovery. Do not treat a successful replay as proof that an old encrypted message has been recovered.

## Early invalid-request errors

Copilot can announce a stream, send `response.failed` with no error details, then send an `error` containing the real `invalid_request_body` diagnostic. A downstream gateway may otherwise act on the empty failure and report a misleading retryable 502.

For opted-in models, the gateway inspects an initial prefix before committing HTTP streaming headers. An early explicit invalid-request error is returned as HTTP 400 with its original code, message, and parameter. Usage present in the consumed failed event is still recorded.

The prefix is bounded to 16 events, 256 KiB, and two seconds. Waiting for a trailing error after an empty failure is limited to 250 milliseconds within that deadline. The first event with model output ends inspection immediately. Successful output is not buffered to completion, and an outstanding read is preserved if the deadline expires. Failures after output starts, other error classifications, and failures outside the inspected prefix retain the existing streaming behavior. This mode adds no retries and deletes no history.

## Validation before enabling

Run the regression tests, typecheck, repository lint, and build on the deployed version. Validate an actual Codex parent/child lifecycle and restart/resume through the complete gateway route using disposable sessions. Keep the previous image and configuration available for rollback and enable only the tested models.
