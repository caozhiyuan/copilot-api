import { useEffect, useId, useRef, useState } from 'react'
import { useLanguage } from '../contexts/LanguageContext'
import type { Language } from '../locales'

interface Props {
  locale: Language
  value: string
  onChange: (value: string) => void
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function calendarDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && dateKey(date) === value ?
      date
    : undefined
}

function addDays(date: Date, days: number): Date {
  const shifted = new Date(date)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted
}

const dayOffsets: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
}

const controlClass =
  'flex h-9 items-center rounded-lg border border-line bg-canvas focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-400/15'
const iconButtonClass =
  'grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-md text-ink-soft outline-none hover:bg-sunken hover:text-ink focus-visible:ring-2 focus-visible:ring-blue-400'

export default function ApiKeyExpiryPicker({ locale, value, onChange }: Props) {
  const { t } = useLanguage()
  const dateId = useId()
  const calendarId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const focusedDay = useRef<HTMLButtonElement>(null)
  const [cursor, setCursor] = useState<Date | null>(null)
  const [date = '', time = ''] = value.split('T')
  const now = new Date()
  const today = new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()),
  )

  useEffect(() => {
    if (cursor) focusedDay.current?.focus()
  }, [cursor])

  const changeDate = (nextDate: string) => {
    onChange(nextDate ? `${nextDate}T${time || '23:59'}` : '')
  }
  const closeCalendar = () => {
    setCursor(null)
    trigger.current?.focus()
  }
  const monthStart = cursor && addDays(cursor, 1 - cursor.getUTCDate())
  const nextMonth = monthStart && new Date(monthStart)
  if (nextMonth) nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)
  const monthDays =
    monthStart && nextMonth ?
      Array.from({ length: addDays(nextMonth, -1).getUTCDate() }, (_, index) =>
        addDays(monthStart, index),
      )
    : []
  const leadingDays =
    monthStart ?
      (monthStart.getUTCDay() - (locale === 'zh' ? 1 : 0) + 7) % 7
    : 0
  const monthLabel = new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
  const weekdayLabel = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    timeZone: 'UTC',
  })
  const dayLabel = new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeZone: 'UTC',
  })
  const changeMonth = (amount: number) => {
    if (!monthStart) return
    const month = new Date(monthStart)
    month.setUTCMonth(month.getUTCMonth() + amount)
    setCursor(month)
  }

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 text-xs">
        <label htmlFor={dateId} className="text-ink-soft">
          {t('apiKeys.expires')}
        </label>
        {value && (
          <button
            type="button"
            className="cursor-pointer rounded-sm text-ink-soft outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-blue-400"
            onClick={() => {
              onChange('')
              closeCalendar()
            }}
          >
            {t('apiKeys.clearExpiry')}
          </button>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[13px] text-ink">
        <div
          className={`relative min-w-0 flex-1 ${controlClass}`}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setCursor(null)
          }}
          onKeyDown={(event) => {
            if (cursor && event.key === 'Escape') {
              event.preventDefault()
              closeCalendar()
            }
          }}
        >
          <input
            id={dateId}
            aria-label={t('apiKeys.expiryDate')}
            className="min-w-0 flex-1 bg-transparent pl-3 outline-none placeholder:text-ink-faint"
            placeholder={t('apiKeys.expiryDatePlaceholder')}
            maxLength={10}
            value={date}
            onChange={(event) => changeDate(event.target.value)}
          />
          <button
            ref={trigger}
            type="button"
            aria-label={t('apiKeys.pickExpiryDate')}
            aria-haspopup="dialog"
            aria-expanded={cursor !== null}
            aria-controls={calendarId}
            className={`mr-0.5 ${iconButtonClass}`}
            onClick={() =>
              setCursor(cursor ? null : (calendarDate(date) ?? today))
            }
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              <rect x="3" y="5" width="18" height="16" rx="2.5" />
              <path d="M8 3v4m8-4v4M3 10h18" strokeLinecap="round" />
            </svg>
          </button>
          {cursor && monthStart && (
            <div
              id={calendarId}
              role="dialog"
              aria-label={t('apiKeys.pickExpiryDate')}
              lang={locale}
              className="absolute top-full left-0 z-20 mt-2 w-64 rounded-xl border border-line bg-surface p-3 shadow-lg"
            >
              <div className="flex items-center justify-between gap-1">
                <button
                  type="button"
                  className={iconButtonClass}
                  aria-label={t('apiKeys.previousMonth')}
                  onClick={() => changeMonth(-1)}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    aria-hidden="true"
                  >
                    <path
                      d="m10 4-4 4 4 4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <span className="font-medium text-ink" aria-live="polite">
                  {monthLabel.format(monthStart)}
                </span>
                <button
                  type="button"
                  className={iconButtonClass}
                  aria-label={t('apiKeys.nextMonth')}
                  onClick={() => changeMonth(1)}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    aria-hidden="true"
                  >
                    <path
                      d="m6 4 4 4-4 4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
              <div className="mt-1.5 grid grid-cols-7 gap-y-0.5 text-center text-xs">
                {Array.from({ length: 7 }, (_, index) => {
                  const weekday = weekdayLabel.format(
                    addDays(monthStart, index - leadingDays),
                  )
                  return (
                    <span key={weekday} className="py-1 text-ink-faint">
                      {weekday}
                    </span>
                  )
                })}
                {monthDays.map((day, index) => {
                  const key = dateKey(day)
                  const active = day.getTime() === cursor.getTime()
                  return (
                    <button
                      key={key}
                      ref={active ? focusedDay : undefined}
                      type="button"
                      tabIndex={active ? 0 : -1}
                      aria-label={dayLabel.format(day)}
                      aria-current={key === dateKey(today) ? 'date' : undefined}
                      aria-pressed={key === date}
                      style={
                        index === 0 ?
                          { gridColumnStart: leadingDays + 1 }
                        : undefined
                      }
                      className="mx-auto grid size-7 cursor-pointer place-items-center rounded-md tabular-nums text-ink outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-blue-400 aria-[current=date]:font-semibold aria-pressed:bg-blue-600 aria-pressed:text-white aria-pressed:hover:bg-blue-700"
                      onKeyDown={(event) => {
                        const offset = dayOffsets[event.key]
                        if (offset === undefined) return
                        event.preventDefault()
                        setCursor(addDays(day, offset))
                      }}
                      onClick={() => {
                        changeDate(key)
                        closeCalendar()
                      }}
                    >
                      {day.getUTCDate()}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
        <div className={`shrink-0 gap-1.5 px-2.5 ${controlClass}`}>
          <svg
            className="text-ink-soft"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path
              d="M12 7v5l3 2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <input
            aria-label={t('apiKeys.expiryTime')}
            className="w-11 bg-transparent text-center tabular-nums outline-none placeholder:text-ink-faint"
            placeholder="HH:mm"
            maxLength={5}
            value={time}
            onChange={(event) => {
              const nextTime = event.target.value
              onChange(date || nextTime ? `${date}T${nextTime}` : '')
            }}
          />
        </div>
      </div>
    </div>
  )
}
