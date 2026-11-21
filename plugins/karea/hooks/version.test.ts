import { expect, mock, test } from 'claude-code/testing'

// KA1192: session start says so when this copy is older than the marketplace's.
function setup(on: Parameters<Parameters<typeof test>[2]>[1], mine: string, latest: string | null) {
  const toasts: string[] = []
  mock.env(on, { HOME: '/tmp' })
  on('fs.read', ($, e) => ((e as { path: string }).path.endsWith('.claude-plugin/plugin.json') ? { value: JSON.stringify({ name: 'karea', version: mine }) } : { value: '' }) as never)
  on('http.fetch', ($, e) => ({
    value: e.url.includes('raw.githubusercontent.com') && latest
      ? { status: 200, ok: true, headers: {}, text: JSON.stringify({ name: 'karea', version: latest }) }
      : { status: 503, ok: false, headers: {}, text: '' },
  }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', ($, e) => { toasts.push((e as { text: string }).text); return { value: undefined } as never })
  on('ui.status', () => ({ value: undefined }) as never)
  on('session.id', () => ({ value: 'session-v' }))
  on('command.register', () => ({ value: undefined }) as never)
  mock.clock(on, { now: Date.parse('2026-11-21T10:00:00Z') })
  on('session.start', ($, e) => e)
  return toasts
}

const settle = () => new Promise((r) => setTimeout(r, 300))

test('older copy: a notice names both versions', {}, async ($, on) => {
  const toasts = setup(on, '0.4.4', '0.4.13')
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await settle()
  expect(toasts.length).toBe(1)
  expect(toasts[0].includes('0.4.4') && toasts[0].includes('0.4.13')).toBe(true)
})

test('up to date: no notice', {}, async ($, on) => {
  const toasts = setup(on, '0.4.13', '0.4.13')
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await settle()
  expect(toasts.length).toBe(0)
})

test('GitHub unreachable: no notice', {}, async ($, on) => {
  const toasts = setup(on, '0.4.4', null)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await settle()
  expect(toasts.length).toBe(0)
})
