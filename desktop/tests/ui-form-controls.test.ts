import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, createElement } from 'react'
import {
  CheckboxSwitch,
  Field,
  segmentedButtonClass,
  SettingRow,
  Toggle,
} from '../src/components/ui/FormControls'
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
              checked: false,
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

    const toggleButton = dom.container.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    )!
    expect(toggleButton.getAttribute('aria-checked')).toBe('false')
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
})
