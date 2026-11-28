import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, createElement } from 'react'
import {
  CheckboxSwitch,
  Field,
  segmentedButtonClass,
  SettingRow,
  Toggle,
} from '../src/components/ui/FormControls'
import {
  ChartSkeleton,
  InlineLoading,
  LoadingSpinner,
  PageLoadingSkeleton,
  TableSkeleton,
} from '../src/components/ui/LoadingState'
import { createTestDom } from './helpers/dom'

let dom: Awaited<ReturnType<typeof createTestDom>>

beforeEach(async () => {
  dom = await createTestDom()
})

afterEach(async () => {
  await act(async () => dom.root.unmount())
  await dom.cleanup()
})

describe('shared UI form controls', () => {
  test('renders Field, Toggle, CheckboxSwitch, SettingRow and segmentedButtonClass', async () => {
    const onToggle = mock((_value: boolean) => {})
    const onCheck = mock((_value: boolean) => {})

    await act(async () => {
      dom.root.render(
        createElement(
          'div',
          null,
          createElement(Field, {
            label: 'Model name',
            children: createElement('input', { type: 'text' }),
          }),
          createElement(SettingRow, {
            label: 'Auto start',
            description: 'Start when opening the app',
            children: createElement(Toggle, {
              ariaLabel: 'Auto start',
              checked: false,
              onChange: onToggle,
            }),
          }),
          createElement(SettingRow, {
            label: 'Enabled switch',
            children: createElement(Toggle, {
              ariaLabel: 'Enabled switch',
              checked: true,
              onChange: onToggle,
            }),
          }),
          createElement(SettingRow, {
            label: 'Without description',
            children: createElement(CheckboxSwitch, {
              id: 'feature-switch',
              ariaLabel: 'Enable feature',
              checked: true,
              onChange: onCheck,
            }),
          }),
        ),
      )
    })

    expect(dom.container.textContent).toContain('Model name')
    expect(dom.container.textContent).toContain('Start when opening the app')

    const toggleButtons = [
      ...dom.container.querySelectorAll<HTMLButtonElement>(
        'button[role="switch"]',
      ),
    ]
    const toggleButton = toggleButtons[0]
    expect(toggleButton.getAttribute('aria-label')).toBe('Auto start')
    expect(toggleButton.getAttribute('aria-checked')).toBe('false')
    expect(toggleButton.classList.contains('ring-line')).toBe(true)
    expect(toggleButton.classList.contains('ring-brand')).toBe(false)
    expect(toggleButtons[1].classList.contains('ring-brand')).toBe(true)
    expect(toggleButtons[1].classList.contains('ring-line')).toBe(false)
    expect(dom.container.innerHTML).not.toContain('dark:border-white/10')
    await act(async () => toggleButton.click())
    expect(onToggle).toHaveBeenCalledWith(true)

    const checkbox = dom.container.querySelector<HTMLInputElement>(
      'input[role="switch"]',
    )!
    expect(checkbox.id).toBe('feature-switch')
    expect(checkbox.checked).toBe(true)
    await act(async () => checkbox.click())
    expect(onCheck).toHaveBeenCalledWith(false)

    expect(segmentedButtonClass(true, 'extra')).toContain('shadow-sm')
    expect(segmentedButtonClass(false)).toContain('text-ink-soft')
  })

  test('renders accessible LoadingState spinner and skeletons', async () => {
    await act(async () => {
      dom.root.render(
        createElement(
          'div',
          null,
          createElement(LoadingSpinner, { size: 16 }),
          createElement(InlineLoading, { label: 'Syncing logs' }),
          createElement(TableSkeleton, { label: 'Loading rows', rows: 3 }),
          createElement(ChartSkeleton, { label: 'Loading chart' }),
          createElement(PageLoadingSkeleton, {
            delayed: true,
            label: 'Loading workspace',
          }),
          createElement(PageLoadingSkeleton, {
            compact: true,
            cards: 2,
            label: 'Loading split',
          }),
          createElement(PageLoadingSkeleton, {
            compact: true,
            cards: 4,
            label: 'Loading grid',
          }),
        ),
      )
    })

    const statuses = [...dom.container.querySelectorAll('[role="status"]')]
    expect(statuses).toHaveLength(6)
    expect(dom.container.textContent).toContain('Syncing logs')
    expect(dom.container.textContent).toContain('Loading rows')
    expect(dom.container.textContent).toContain('Loading chart')
    expect(dom.container.textContent).toContain('Loading workspace')
    expect(dom.container.querySelector('.loading-delayed-fade')).not.toBeNull()
    expect(
      dom.container.querySelectorAll('.skeleton-shimmer').length,
    ).toBeGreaterThan(20)
  })
})
