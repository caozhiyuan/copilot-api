export function fmtIso(ms?: number | null): string {
  if (ms == null) return ""
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? "" : d.toISOString()
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

export function fmtLocalDateTime(ms?: number | null): string {
  if (ms == null) return ""
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ""

  const yyyy = d.getFullYear()
  const mm = pad2(d.getMonth() + 1)
  const dd = pad2(d.getDate())
  const hh = pad2(d.getHours())
  const min = pad2(d.getMinutes())
  const ss = pad2(d.getSeconds())

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`
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
