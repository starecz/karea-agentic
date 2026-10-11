import { expect, mock, test } from 'claude-code/testing'

import {
  changesWindow,
  parseTaskChanges,
  personChanges,
  statusFromChanges,
  subtaskAnswerContext,
  subtaskRefusal,
  taskChangeLine,
} from './rules'

const ID = '11111111-2222-4333-8444-555555555555'
const START = Date.parse('2026-10-07T10:00:00Z')

function viewText(status: string) {
  return [
    '**Claude Code mods**',
    `Status: ${status} (Doing) · Priority: P3`,
    '',
    `ID: ${ID}`,
    'Short ID: KA747',
  ].join('\n')
}

function changesText(rows: string[], minutes: number) {
  const head = ['KA747 Claude Code mods', 'Status color: #facc15 Doing', 'Last changed: 2026-10-07T10:01:30Z']
  if (rows.length === 0) return [...head, `No changes to KA747 in the last ${minutes} minutes.`].join('\n')
  return [...head, `${rows.length} changes in the last ${minutes} minutes, newest first:`, ...rows].join('\n')
}

const ROWS = [
  '- 2026-10-07T10:01:40Z Note added: "Waiting on design review" · by Alex (user)',
  '- 2026-10-07T10:01:30Z status: in_progress -> blocked · by Alex (ai)',
  '- 2026-10-07T10:01:20Z Context entry edited: "Plan" · by Sam (mcp)',
]

test('reads karea_task_changes rows and keeps only what a person changed', async () => {
  const rows = parseTaskChanges(changesText(ROWS, 3))
  expect(rows).toHaveLength(3)
  expect(rows[0]).toEqual({ at: Date.parse('2026-10-07T10:01:40Z'), stamp: '2026-10-07T10:01:40Z', text: 'Note added: "Waiting on design review"', by: 'Alex', mode: 'user' })
  const fresh = personChanges(rows, START, [])
  expect(fresh.map(taskChangeLine)).toEqual(['status in_progress → blocked (Alex)', 'new note: "Waiting on design review" (Alex)'])
  expect(personChanges(rows, Date.parse('2026-10-07T10:01:35Z'), [])).toHaveLength(1)
  expect(statusFromChanges(rows)).toBe('blocked')
  expect(parseTaskChanges(changesText([], 5))).toEqual([])
})

test('asks for the minutes since the last check, and nothing past 60', async () => {
  expect(changesWindow(0, START)).toBe(undefined)
  expect(changesWindow(START, START + 61000)).toBe(3)
  expect(changesWindow(START, START + 5 * 60000)).toBe(6)
  expect(changesWindow(START, START + 60 * 60000)).toBe(60)
  expect(changesWindow(START, START + 61 * 60000)).toBe(undefined)
})

const REFUSED = [
  'Cannot close "Claude Code mods" yet: it has 2 open subtasks:',
  '  - KA748 Changes endpoint (in progress)',
  '  - KA749 Docs (open)',
  'Closing it closes them too. Close them all (/ct KA747 -subtasks all) or only this task (/ct KA747 -subtasks only)? Closed alone, the task leaves the dashboard while its subtasks stay open.',
].join('\n')

test("reads Karea's open-subtasks question", async () => {
  expect(subtaskRefusal(REFUSED)).toEqual({
    title: 'Claude Code mods',
    count: 2,
    subtasks: ['KA748 Changes endpoint (in progress)', 'KA749 Docs (open)'],
  })
  expect(subtaskRefusal('Task "Claude Code mods" closed.')).toBe(undefined)
  expect(subtaskAnswerContext(undefined, 'karea_close_task', 'mcp__karea__karea_tasks_write')).toContain('Ask the user')
})

test('polls karea_task_changes with the minutes since the last check', { options: { pollSeconds: 60 } }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.env(on, { HOME: '/tmp' })
  let rows: string[] = []
  const calls: { action: string; params: Record<string, unknown> }[] = []
  on('mcp.call', ($, e) => {
    const { server, args } = e as unknown as { server: string; args: { action: string; params: Record<string, unknown> } }
    if (server !== 'karea') throw new Error('not connected')
    calls.push(args)
    const text =
      args.action === 'karea_view_task'
        ? viewText('in_progress')
        : args.action === 'karea_get_context'
          ? '# Context: none'
          : args.action === 'karea_task_changes'
            ? changesText(rows, Number(args.params.sinceMinutes))
            : 'ok'
    return { value: { content: [{ type: 'text', text }], isError: false } } as never
  })
  on('session.id', () => ({ value: 's' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => e as never)
  on('prompt.submit', ($, e) => e as never)
  on('tool.call', () => ({ result: '', text: '' }) as never)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'ksync', args: 'pick KA747' } as never)
  const viewsAfterPick = calls.filter(call => call.action === 'karea_view_task').length

  await clock.advance(61000)
  const quiet = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(quiet.text).not.toContain('Changed in Karea')
  const first = calls.filter(call => call.action === 'karea_task_changes')
  expect(first).toHaveLength(1)
  expect(first[0]?.params).toEqual({ task: ID, sinceMinutes: 2 })
  expect(calls.filter(call => call.action === 'karea_view_task')).toHaveLength(viewsAfterPick)

  rows = ROWS
  await clock.advance(61000)
  const changed = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(changed.text).toContain('Changed in Karea: status in_progress → blocked (Alex); new note: "Waiting on design review" (Alex)')
  expect(changed.text).toContain('· blocked')
  expect(changed.text).not.toContain('Plan')

  await clock.advance(61000)
  const again = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(again.text.match(/blocked \(Alex\)/g)).toHaveLength(1)

  // Polls pause 30 minutes after the last prompt. Back after 95 minutes, the last check is over an hour old,
  // so the next poll re-reads the task once instead of asking for changes.
  await clock.advance(95 * 60000)
  await $.prompt.submit({ text: 'back', origin: { kind: 'composer' } } as never)
  const before = calls.length
  await clock.advance(61000)
  expect(calls.slice(before).map(call => call.action)).toEqual(['karea_view_task'])
  await clock.advance(61000)
  expect(calls.at(-1)?.action).toBe('karea_task_changes')
})

function storeMock(on: Parameters<Parameters<typeof test>[1]>[1], memory: Record<string, unknown>) {
  on('store.get', ($, e) => ({ value: memory[(e as unknown as { key: string }).key] }) as never)
  on('store.set', ($, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    memory[key] = value
    return { value: undefined } as never
  })
}

const HINT = { component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } as never } as const

test('picks the task Karea Connect started the session for, and keeps it for that session', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.env(on, { HOME: '/tmp', KAREA_TASK: 'KA747' })
  const memory: Record<string, unknown> = {}
  storeMock(on, memory)
  on('mcp.call', ($, e) => {
    const { args } = e as unknown as { args: { action: string } }
    const text = args.action === 'karea_view_task' ? viewText('in_progress') : args.action === 'karea_get_context' ? '# Context: none' : 'ok'
    return { value: { content: [{ type: 'text', text }], isError: false } } as never
  })
  on('session.id', () => ({ value: 'session-a' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => e as never)
  on('tool.call', () => ({ result: '', text: '' }) as never)
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as never)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  const status = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(status.text).toMatch(/^KA747 Claude Code mods/)
  const hint = await $.ui.mount({ plugin: 'karea', surface: 'terminal', ...HINT })
  expect((await hint.find({ type: 'Text', text: /KA747/ }))?.text).toContain('● KA747 Claude Code mods')
  await hint.unmount()
  expect((memory.sessionTasks as Record<string, { shortid: string }>)['session-a']?.shortid).toBe('KA747')

})

test('a resumed session gets its own task back, even when Karea Connect names another', async ($, on) => {
  mock.clock(on, { now: START })
  mock.env(on, { HOME: '/tmp', KAREA_TASK: 'KA747' })
  const memory: Record<string, unknown> = {
    sessionTasks: {
      'session-a': { shortid: 'KA9', id: '', title: 'Fix the login', status: 'in_progress' },
      'session-b': 'off',
    },
  }
  storeMock(on, memory)
  let id = 'session-a'
  on('session.id', () => ({ value: id }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => e as never)
  on('tool.call', () => ({ result: '', text: '' }) as never)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true, source: 'resume' } as never)
  const resumed = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(resumed.text).toMatch(/^KA9 Fix the login/)

  await $.command.run({ command: 'ksync', args: 'off' } as never)
  expect((memory.sessionTasks as Record<string, unknown>)['session-a']).toBe('off')

  id = 'session-b'
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true, source: 'resume' } as never)
  const off = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(off.text).toContain('No active Karea task')
})

test('a close refused for open subtasks asks the user and passes the answer back', async ($, on) => {
  mock.clock(on, { now: START })
  mock.env(on, { HOME: '/tmp' })
  let asked = ''
  on('tool.call', ($, e) => {
    const call = e as unknown as { tool: string; questions?: { question: string; options: { label: string }[] }[] }
    if (call.tool === 'AskUserQuestion') {
      asked = call.questions?.[0]?.question ?? ''
      return { result: { answers: { [asked]: 'Close them all' } }, text: '' } as never
    }
    if (call.tool === 'Bash') return { result: { stdout: '[main 3c3b8de] x', stderr: '', interrupted: false }, text: '' } as never
    return { result: '', text: REFUSED } as never
  })

  await $.command.run({ command: 'ksync', args: 'pick KA747' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  const ran = (await $.tool.call({
    tool: 'mcp__karea__karea_tasks_write',
    action: 'karea_close_task',
    params: { task: 'KA747', resolution: 'Shipped' },
  })) as { context?: string[] }

  expect(asked).toContain('has 2 open subtasks (KA748 Changes endpoint (in progress); KA749 Docs (open))')
  expect(ran.context?.join(' ')).toContain('call mcp__karea__karea_tasks_write with action karea_close_task again, with the same params plus closeSubtasks: true')
  const status = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(status.text).toContain('Not synced yet: committed')
})
