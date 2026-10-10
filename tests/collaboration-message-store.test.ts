import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ResponsesPayload } from "~/lib/types/responses"

import { PlaintextCollaborationStore } from "~/lib/collaboration-message-store"
import { openSqliteDatabase } from "~/lib/sqlite"

const directories: Array<string> = []
const stores: Array<PlaintextCollaborationStore> = []

function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-plaintext-test-"),
  )
  directories.push(directory)
  const dbPath = path.join(directory, "copilot-api.sqlite")
  const store = new PlaintextCollaborationStore(() => dbPath)
  stores.push(store)
  return { store, dbPath }
}

function child(message: string): ResponsesPayload {
  return {
    model: "gpt-test",
    input: [
      {
        type: "agent_message",
        id: "message_1",
        author: "/root",
        recipient: "/root/child",
        content: [
          { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
          { type: "encrypted_content", encrypted_content: message },
        ],
      },
    ],
  }
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => {})
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

describe("plaintext collaboration message storage", () => {
  test("repairs only a message previously emitted as plaintext, preserving its exact contents", async () => {
    const { store } = fixture()
    const text =
      'Reply with 租約 😀 "quoted"\nexactly; collaboration.spawn_agent'
    await store.remember([text])
    const payload = child(text)
    expect(await store.restoreAgentMessages(payload)).toBe(1)
    expect(payload.input).toEqual([
      {
        type: "agent_message",
        id: "message_1",
        author: "/root",
        recipient: "/root/child",
        content: [
          { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
          { type: "input_text", text },
        ],
      },
    ])
    expect(await store.restoreAgentMessages(payload)).toBe(0)
  })

  test("unknown ciphertext and unregistered plaintext are not reclassified", async () => {
    const { store } = fixture()
    await store.remember(["known message"])
    for (const text of [
      "opaque-legacy-ciphertext",
      "unregistered plain message",
      "known message ",
    ]) {
      const payload = child(text)
      const before = structuredClone(payload)
      expect(await store.restoreAgentMessages(payload)).toBe(0)
      expect(payload).toEqual(before)
    }
  })

  test("never rewrites reasoning, compaction, tool outputs, or ordinary input content", async () => {
    const { store } = fixture()
    const message = "known message"
    await store.remember([message])
    // Malformed optional fields must also remain available for upstream validation.
    const payload = {
      model: "gpt-test",
      input: [
        { type: "reasoning", summary: [], encrypted_content: message },
        { type: "compaction", id: "compact_1", encrypted_content: message },
        { type: "function_call_output", call_id: "call_1", output: message },
        {
          type: "message",
          role: "user",
          content: [{ type: "encrypted_content", encrypted_content: message }],
        },
        {
          type: "agent_message",
          content: [
            { type: "input_text", text: message },
            { type: "encrypted_content", encrypted_content: null },
          ],
        },
        { type: "agent_message", content: message },
      ],
    } as unknown as ResponsesPayload
    const before = structuredClone(payload)
    expect(await store.restoreAgentMessages(payload)).toBe(0)
    expect(payload).toEqual(before)
  })

  test("a new process/store can repair saved child history using the persisted hashes", async () => {
    const { store, dbPath } = fixture()
    const message =
      "Persistent diagnostic message 8dba1d6c after a gateway restart"
    await store.remember([message, message])
    await store.close()
    const restarted = new PlaintextCollaborationStore(() => dbPath)
    stores.push(restarted)
    const payload = child(message)
    expect(await restarted.restoreAgentMessages(payload)).toBe(1)
    await restarted.close()
    const db = await openSqliteDatabase(dbPath)
    try {
      expect(
        db
          .prepare(
            "SELECT digest FROM copilot_plaintext_collaboration_messages",
          )
          .all(),
      ).toEqual([
        { digest: createHash("sha256").update(message).digest("hex") },
      ])
    } finally {
      db.close?.()
    }
    expect(fs.readFileSync(dbPath).includes(Buffer.from(message))).toBe(false)
  })

  test("preserves existing application tables and rows", async () => {
    const { store, dbPath } = fixture()
    const db = await openSqliteDatabase(dbPath)
    db.exec("CREATE TABLE existing_usage (tokens INTEGER)")
    db.exec("INSERT INTO existing_usage (tokens) VALUES (123)")
    await store.ready()
    await store.remember(["new diagnostic message"])
    expect(db.prepare("SELECT tokens FROM existing_usage").all()).toEqual([
      { tokens: 123 },
    ])
    db.close?.()
  })

  test("empty operations do not open or create a database", async () => {
    const { store, dbPath } = fixture()
    await store.remember([])
    expect(await store.restoreAgentMessages({ model: "gpt-test" })).toBe(0)
    expect(
      await store.restoreAgentMessages({ model: "gpt-test", input: "hello" }),
    ).toBe(0)
    expect(
      await store.restoreAgentMessages({ model: "gpt-test", input: [] }),
    ).toBe(0)
    expect(fs.existsSync(dbPath)).toBe(false)
  })

  test("storage initialization failures are surfaced before accepting messages", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-invalid-db-"),
    )
    directories.push(directory)
    const store = new PlaintextCollaborationStore(() => directory)
    stores.push(store)
    expect(await store.ready().catch((error: unknown) => error)).toBeInstanceOf(
      Error,
    )
    expect(
      await store
        .remember(["must not silently lose this"])
        .catch((error: unknown) => error),
    ).toBeInstanceOf(Error)
  })
})
