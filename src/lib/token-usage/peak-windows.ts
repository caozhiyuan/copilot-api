// Configured peak-pricing windows use UTC minutes and ISO weekdays so the
// schedule is independent of the host timezone.

export interface TokenUsagePeakWindow {
  // Exclusive end of the peak window, in minutes from 00:00 UTC.
  endMinuteUtc: number
  // Inclusive start of the peak window, in minutes from 00:00 UTC.
  startMinuteUtc: number
  // ISO weekday numbers, 1 = Monday ... 7 = Sunday. Omitted means every day.
  weekdays?: Array<number>
}
