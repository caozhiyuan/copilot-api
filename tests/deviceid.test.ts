import { afterEach, expect, mock, test } from "bun:test"

import { getVSCodeDeviceId } from "../src/lib/deviceid"

const failingRegistryError = new Error("registry unavailable")

class FailingWinreg {
  static HKCU = "HKCU"
  static REG_SZ = "REG_SZ"

  get(
    _name: string,
    callback: (error: Error | null, item: { value?: string } | null) => void,
  ) {
    callback(failingRegistryError, null)
  }

  set(
    ...args: [
      name: string,
      type: string,
      value: string,
      callback: (error: Error | null) => void,
    ]
  ) {
    const callback = args[3]
    callback(failingRegistryError)
  }
}

afterEach(() => {
  mock.restore()
})

test("getVSCodeDeviceId falls back to an ephemeral UUID when persistence fails", async () => {
  await mock.module("winreg", () => ({
    default: FailingWinreg,
  }))

  const deviceId = await getVSCodeDeviceId()

  expect(deviceId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
})
