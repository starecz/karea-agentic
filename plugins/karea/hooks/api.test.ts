import { expect, mock, test } from 'claude-code/testing'

const START = Date.parse('2026-10-07T10:00:00Z')
const ID = '11111111-2222-4333-8444-555555555555'
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10 } as never } as const

type Call = { method: string; url: string; body?: string; auth?: string }

function karea(history: () => unknown[]) {
  const calls: Call[] = []
  const answer = (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    calls.push({ method: init.method ?? 'GET', url, body: init.body, auth: init.headers?.Authorization })
    const json = (status: number, data: unknown) => ({ status, ok: status < 400, headers: {}, text: JSON.stringify(data) })
    if (url.includes('/api/tasks/context?task=KA747')) {
      return json(200, {
        id: ID,
        title: 'Claude Code mods',
        entries: [{ title: 'Plan', updatedAt: '2026-10-07T09:00:00Z', lastEditedMode: 'mcp' }],
      })
    }
    if (url.includes('/api/tasks/context?task=')) {
      return json(200, {
        id: ID,
        title: 'Claude Code mods',
        entries: [{ title: 'Plan', updatedAt: '2026-10-07T09:00:00Z', lastEditedMode: 'mcp' }],
      })
    }
    if (url.endsWith(`/api/tasks/${ID}/history`)) return json(200, history())
    if (url.endsWith(`/api/tasks/${ID}/ai-sessions`)) return json(201, { ok: true })
    if (url.endsWith(`/api/tasks/${ID}`)) return json(200, { id: ID, title: 'Claude Code mods', status: 'open', displayId: 'KA747' })
    return json(404, { error: 'Task not found' })
  }
  return { calls, answer }
}

test(
  'pick through the API, then flag a change made in Karea',
  { options: { apiKey: 'kr_test', baseUrl: 'https://karea.test', pollSeconds: 60 } },
  async ($, on) => {
    const clock = mock.clock(on, { now: START })
    mock.env(on, { HOME: '/tmp' })
    let rows: unknown[] = []
    const server = karea(() => rows)
    on('http.fetch', ($, e) => ({ value: server.answer(e.url, e.init as never) }))
    on('session.id', () => ({ value: 'session-1' }))
    on('command.register', () => ({ value: undefined }) as never)
    on('session.start', ($, e) => e)
    on('tool.call', () => ({ result: { stdout: '', stderr: '   e1f182b..3c3b8de  main -> main', interrupted: false }, text: '' }) as never)
    on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as never)

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

    const picked = await $.command.run({ command: 'ksync', args: 'pick KA747' } as never)
    expect(picked.text).toContain('Active: KA747 Claude Code mods')
    expect(picked.text).toContain('status open → in progress')
    expect(picked.text).toContain('session linked')
    expect(picked.context?.[0]).toContain('Read its context')

    const patch = server.calls.find(call => call.method === 'PATCH')
    expect(patch?.url).toBe(`https://karea.test/api/tasks/${ID}`)
    expect(patch?.body).toBe('{"status":"in_progress"}')
    expect(patch?.auth).toBe('Bearer kr_test')
    const link = server.calls.find(call => call.url.endsWith('/ai-sessions'))
    expect(link?.body).toContain('"sessionId":"session-1"')

    rows = [
      { field: 'status', oldValue: 'open', newValue: 'in_progress', mode: 'mcp', createdAt: '2026-10-07T10:00:30Z' },
      { field: 'status', oldValue: 'in_progress', newValue: 'blocked', mode: 'user', createdAt: '2026-10-07T10:00:40Z' },
    ]
    await clock.advance(61000)

    const status = await $.command.run({ command: 'ksync', args: 'status' } as never)
    expect(status.text).toContain('Changed in Karea: status in_progress → blocked')
    expect(status.text).toContain(`https://karea.test/dashboard/task/${ID}`)

    const band = await $.ui.mount({ plugin: 'karea', surface: 'terminal', ...BAND })
    expect(await band.find({ key: 'reread' })).toBeDefined()
    await band.press({ key: 'later' })
    await band.unmount()

    const after = await $.command.run({ command: 'ksync', args: 'status' } as never)
    expect(after.text).not.toContain('Changed in Karea')

    await $.tool.call({ tool: 'Bash', command: 'git push' })
    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({
        plugin: 'karea',
        surface,
        component: 'Pane',
        requestId: 'karea-task',
        props: { title: 'Karea' } as never,
      })
      expect(await pane.find({ text: /Plan/ })).toBeDefined()
      expect(await pane.find({ text: /stale/ })).toBeDefined()
      expect(await pane.find({ text: /pushed/ })).toBeDefined()
      expect((await pane.find({ key: 'pane-sync' }))?.props.label).toBe('Sync now (1)')
      await pane.unmount()
    }
  },
)

test('an unknown task says so', { options: { apiKey: 'kr_test' } }, async ($, on) => {
  mock.clock(on, { now: START })
  const server = karea(() => [])
  on('http.fetch', ($, e) => ({ value: e.url.includes('KA1') ? server.answer('/nope') : server.answer(e.url) }))
  on('tool.call', () => ({ result: '', text: '' }))

  const picked = await $.command.run({ command: 'ksync', args: 'pick KA1' } as never)
  expect(picked.text).toBe('Could not find KA1 in Karea. Check the ID and your API key.')
  const status = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(status.text).toContain('No active Karea task')
})
