import { expect, mock, test } from 'claude-code/testing'

import { contextAgesOf, diffSnapshots, parseContextText, parseViewTask, snapshotOf } from './rules'

const ID = '11111111-2222-4333-8444-555555555555'

function viewText(status: string, notes: string[]) {
  return [
    '**Claude Code mods for Karea clients: visual task sync status**',
    status === 'review'
      ? 'Status: review (Developer review) · Priority: P3 · Category: Integrations'
      : `Status: ${status.replace(/_/g, ' ')} · Priority: P3 · Category: Integrations`,
    'Description: Build Claude Code mods.',
    'Created: 07 Oct 2026, 12:04 by Alex',
    ...(notes.length > 0 ? ['Notes:', ...notes.map(note => `  ${note}`)] : []),
    '',
    `ID: ${ID}`,
    'Short ID: KA747',
    `Link: https://karea.app/dashboard/task/${ID}`,
  ].join('\n')
}

function contextText(planMode: string, planStamp: string) {
  return [
    '# Context: Claude Code mods (2 entries)',
    '',
    `## Plan  [${planMode}, updated ${planStamp} by Alex]`,
    '',
    '- step one',
    '',
    '---',
    '',
    '## Findings  [mcp, updated 2026-10-07 10:19 by Alex]',
    '',
    '- found it',
  ].join('\n')
}

test('reads Karea MCP task and context text', async () => {
  const task = parseViewTask(viewText('review', ['07 Oct 2026, 12:37 (Alex): Chip moved']))
  expect(task).toEqual({
    id: ID,
    shortid: 'KA747',
    title: 'Claude Code mods for Karea clients: visual task sync status',
    status: 'review',
    notes: ['07 Oct 2026, 12:37 (Alex): Chip moved'],
  })
  expect(parseViewTask('Task not found: KA1')).toBe(undefined)
  expect(parseContextText(contextText('user', '2026-10-07 11:00'))).toEqual([
    { title: 'Plan', mode: 'user', stamp: '2026-10-07 11:00' },
    { title: 'Findings', mode: 'mcp', stamp: '2026-10-07 10:19' },
  ])
})

test('diffs two snapshots into what a person changed', async () => {
  const before = snapshotOf(parseViewTask(viewText('in_progress', []))!, parseContextText(contextText('mcp', '2026-10-07 10:00')))
  const after = snapshotOf(
    parseViewTask(viewText('blocked', ['07 Oct 2026, 13:00 (Alex): Waiting on design review']))!,
    parseContextText(contextText('user', '2026-10-07 13:01')),
  )
  expect(diffSnapshots(before, after)).toEqual([
    'status in_progress → blocked',
    'new note: "Waiting on design review"',
    'context "Plan" edited',
  ])
  expect(diffSnapshots(after, after)).toEqual([])
})

test('falls back to comparing snapshots when the server does not know karea_task_changes', { options: { pollSeconds: 60 } }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
  mock.env(on, { HOME: '/tmp' })
  let status = 'open'
  let notes: string[] = []
  const calls: { server: string; tool: string; args: Record<string, unknown> }[] = []
  on('mcp.call', ($, e) => {
    const { server, tool, args } = e as unknown as { server: string; tool: string; args: { action: string; params: Record<string, unknown> } }
    calls.push({ server, tool, args })
    if (server !== 'claude.ai Karea') throw new Error('not connected')
    const text =
      args.action === 'karea_view_task'
        ? viewText(status, notes)
        : args.action === 'karea_get_context'
          ? contextText('mcp', '2026-10-07 09:00')
          : args.action === 'karea_task_changes'
            ? 'Unknown action "karea_task_changes" for karea_read. karea_read actions: karea_view_task.'
            : 'Task updated.'
    if (args.action === 'karea_edit_task' && typeof args.params.status === 'string') status = args.params.status
    return { value: { content: [{ type: 'text', text }], isError: false } } as never
  })
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => e as never)
  on('tool.call', () => ({ result: '', text: '' }) as never)
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as never)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const picked = await $.command.run({ command: 'ksync', args: 'pick KA747' } as never)
  expect(picked.text).toContain('Active: KA747 Claude Code mods')
  expect(picked.text).toContain('status open → in progress')
  expect(picked.text).toContain('session linked')
  const edit = calls.find(call => call.args.action === 'karea_edit_task')
  expect(edit?.tool).toBe('karea_tasks_write')
  expect((edit?.args.params as Record<string, unknown>).aiSessionId).toBe('session-1')

  await clock.advance(61000)
  const quiet = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(quiet.text).not.toContain('Changed in Karea')

  status = 'blocked'
  notes = ['07 Oct 2026, 12:02 (Alex): Waiting on design review']
  await clock.advance(61000)
  const changed = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(changed.text).toContain('Changed in Karea: status in_progress → blocked; new note: "Waiting on design review"')

  await $.tool.call({
    tool: 'mcp__claude_ai_Karea__karea_tasks_write',
    action: 'karea_edit_task',
    params: { task: 'KA747', status: 'review' },
  })
  status = 'review'
  await clock.advance(61000)
  const own = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(own.text).not.toContain('blocked → review')
})

test('checks Karea every 5 minutes unless the user chose otherwise', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
  mock.env(on, { HOME: '/tmp' })
  let views = 0
  on('mcp.call', ($, e) => {
    const { server, args } = e as unknown as { server: string; args: { action: string } }
    if (server !== 'karea') throw new Error('not connected')
    if (args.action === 'karea_view_task' || args.action === 'karea_task_changes') views += 1
    const text = args.action === 'karea_view_task' ? viewText('open', []) : args.action === 'karea_get_context' ? contextText('mcp', '2026-10-07 09:00') : 'ok'
    return { value: { content: [{ type: 'text', text }], isError: false } } as never
  })
  on('session.id', () => ({ value: 's' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => e as never)
  on('tool.call', () => ({ result: '', text: '' }) as never)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'ksync', args: 'pick KA747' } as never)
  const afterPick = views
  await clock.advance(4 * 60000)
  expect(views).toBe(afterPick)
  await clock.advance(61000)
  expect(views).toBe(afterPick + 1)
})

test('karea_get_context stamps are UTC, whatever the machine timezone', () => {
  const [plan] = contextAgesOf(parseContextText(contextText('user', '2026-10-07 09:00')))
  expect(plan?.updatedAt).toBe(Date.parse('2026-10-07T09:00:00Z'))
})

test('reads the status as Karea prints it, with spaces', () => {
  expect(parseViewTask(viewText('in_progress', []))?.status).toBe('in_progress')
  expect(parseViewTask(viewText('review', []))?.status).toBe('review')
})
