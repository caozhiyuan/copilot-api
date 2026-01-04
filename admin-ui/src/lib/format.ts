export function fmtIso(ms?: number | null): string {
  if (ms == null) return ""
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? "" : d.toISOString()
}

export function fmtNum(n?: number | null): string {
  if (n == null) return ""
  if (!Number.isFinite(n)) return ""
  return Intl.NumberFormat("en-US").format(n)
}

export function fmtMaybeNum(n?: number | null): string {
  if (n == null) return ""
  return String(n)
}
