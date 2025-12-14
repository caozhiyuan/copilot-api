const escCharCode = 27
const belCharCode = 7
const csiCharCode = 0x9b

function codeAt(input: string, index: number): number {
  return input.codePointAt(index) ?? -1
}

function skipCsiSequence(input: string, startIndex: number): number {
  const inputLength = input.length
  let index = startIndex

  while (index < inputLength) {
    const code = codeAt(input, index)
    if (code >= 0x40 && code <= 0x7e) return index + 1
    index += 1
  }

  return inputLength
}

function skipStringTerminatedSequence(
  input: string,
  startIndex: number,
): number {
  const inputLength = input.length
  let index = startIndex

  while (index < inputLength) {
    const code = codeAt(input, index)

    if (code === belCharCode) return index + 1

    if (code === escCharCode && codeAt(input, index + 1) === 92) {
      return Math.min(index + 2, inputLength)
    }

    index += 1
  }

  return inputLength
}

export function stripAnsi(input: string): string {
  const inputLength = input.length
  let lastIndex = 0
  let index = 0
  const parts: Array<string> = []

  while (index < inputLength) {
    const code = codeAt(input, index)
    if (code !== escCharCode && code !== csiCharCode) {
      index += 1
      continue
    }

    if (index > lastIndex) parts.push(input.slice(lastIndex, index))

    if (code === csiCharCode) {
      index = skipCsiSequence(input, index + 1)
      lastIndex = index
      continue
    }

    const next = input[index + 1]
    if (next === "[") {
      index = skipCsiSequence(input, index + 2)
      lastIndex = index
      continue
    }

    if (
      next === "]"
      || next === "P"
      || next === "X"
      || next === "^"
      || next === "_"
    ) {
      index = skipStringTerminatedSequence(input, index + 2)
      lastIndex = index
      continue
    }

    index = Math.min(index + 2, inputLength)
    lastIndex = index
  }

  if (parts.length === 0) return input
  if (lastIndex < inputLength) parts.push(input.slice(lastIndex))
  return parts.join("")
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}
