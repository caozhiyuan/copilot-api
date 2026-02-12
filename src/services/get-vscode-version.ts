const FALLBACK = "1.109.2"

export async function getVSCodeVersion() {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, 5000)

  try {
    const response = await fetch(
      "https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h=visual-studio-code-bin",
      {
        signal: controller.signal,
      },
    )

    const pkgbuild = await response.text()
    const pkgverRegex = /pkgver=([0-9.]+)/
    const match = pkgbuild.match(pkgverRegex)

    if (match) {
      if (match[1] === "1.109.0") {
        return FALLBACK
      }
      return match[1]
    }

    return FALLBACK
  } catch {
    return FALLBACK
  } finally {
    clearTimeout(timeout)
  }
}

await getVSCodeVersion()
