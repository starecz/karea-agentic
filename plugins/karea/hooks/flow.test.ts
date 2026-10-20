import { expect, mock, test } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10 } as never } as const

function shell(command: string) {
  const stdout = /commit/.test(command) ? '[main 3c3b8de] x\n 1 file changed' : ''
  const stderr = /\bpush\b/.test(command) ? '   e1f182b..3c3b8de  main -> main' : ''
  return { result: { stdout, stderr, interrupted: false }, text: '' }
}

test('pick, fall behind, sync, guard /clear', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
  mock.env(on, { HOME: '/tmp' })
  on('tool.call', ($, e) => (e.tool === 'Bash' ? shell(e.command) : { result: '', text: '' }) as never)
  on('command.run', () => ({ text: 'cleared' }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as never)

  const picked = await $.command.run({ command: 'ksync', args: 'pick KA9' } as never)
  expect(picked.text).toContain('Active: KA9')
  expect(picked.context?.[0]).toContain('set it to in_progress')

  for (const surface of ['terminal', 'desktop'] as const) {
    const quiet = await $.ui.mount({ plugin: 'karea', surface, ...BAND })
    expect(await quiet.find({ key: 'sync' })).toBe(undefined)
    await quiet.unmount()
  }

  await $.tool.call({ tool: 'Bash', command: 'git commit -m x && git push' })

  const status = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(status.text).toContain('Not synced yet: committed, pushed')

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'karea', surface, ...BAND })
    expect(await band.find({ key: 'sync' })).toBeDefined()
    expect(await band.find({ text: /KA9 behind/ })).toBeDefined()
    await band.unmount()
  }

  const guarded = await $.command.run({ command: 'clear' } as never)
  expect(guarded.text).toContain('KA9 has 2 unsynced events')
  const cleared = await $.command.run({ command: 'clear' } as never)
  expect(cleared.text).toBe('cleared')

  await $.tool.call({ tool: 'Bash', command: 'git push' })
  await $.tool.call({
    tool: 'mcp__karea__karea_notes_write',
    action: 'karea_add_note',
    params: { task: 'KA9', content: 'Pushed the fix' },
  })

  const after = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(after.text).toContain('Nothing waiting to be synced.')
  const band = await $.ui.mount({ plugin: 'karea', surface: 'terminal', ...BAND })
  expect(await band.find({ key: 'sync' })).toBe(undefined)
  await band.unmount()

  const recap = await $.command.run({ command: 'ksync', args: 'recap' } as never)
  expect(recap.text).toContain('● KA9 (active)')
})

test('a Karea write picks the task when none is active', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
  mock.env(on, { HOME: '/tmp' })
  on('tool.call', ($, e) => (e.tool === 'Bash' ? shell(e.command) : { result: '', text: '' }) as never)

  await $.tool.call({
    tool: 'mcp__karea__karea_tasks_write',
    action: 'karea_edit_task',
    params: { task: 'KA12', status: 'in_progress' },
  })
  const status = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(status.text).toMatch(/^KA12 /)
})

test('commands are ignored with no active task', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
  mock.env(on, { HOME: '/tmp' })
  on('tool.call', ($, e) => (e.tool === 'Bash' ? shell(e.command) : { result: '', text: '' }) as never)

  await $.tool.call({ tool: 'Bash', command: 'git push' })
  const status = await $.command.run({ command: 'ksync', args: '' } as never)
  expect(status.text).toContain('No active Karea task')
})

test('a decision or open question in a reply is flagged, unless Claude already wrote to Karea', { options: { detectDecisions: true } }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
  mock.env(on, { HOME: '/tmp' })
  on('tool.call', ($, e) => (e.tool === 'Bash' ? shell(e.command) : { result: '', text: '' }) as never)
  on('model.complete', () =>
    ({ value: {
      isAnswered: true,
      text: '{"decisions":[{"text":"Drop deploy alerts","madeBy":"developer","kind":"scope","why":"too noisy","settled":true}],"questions":[{"text":"Can Acme share the SSO metadata?","answeredBy":"external","party":"Acme client"}]}',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } }) as never,
  )
  on('turn.complete', ($, e) => e as never)

  await $.command.run({ command: 'ksync', args: 'pick KA9' } as never)
  await $.turn.complete({ reason: 'answer', answer: 'We will drop deploy alerts.', text: '', turnId: 't1' } as never)
  await clock.advance(10)

  const status = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(status.text).toContain('decision: Drop deploy alerts')
  expect(status.text).toContain('open question for Acme client: Can Acme share the SSO metadata?')

  await $.tool.call({ tool: 'mcp__karea__karea_notes_write', action: 'karea_set_context', params: { task: 'KA9', title: 'Decisions', context: 'x' } })
  await $.turn.complete({ reason: 'answer', answer: 'Recorded it.', text: '', turnId: 't2' } as never)
  await clock.advance(10)
  const after = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(after.text).toContain('Nothing waiting to be synced.')
})

test('decision detection is off by default: no model call, nothing flagged', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
  mock.env(on, { HOME: '/tmp' })
  let calls = 0
  on('model.complete', () => {
    calls += 1
    return { value: { isAnswered: true, text: '{"decisions":[],"questions":[]}', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } as never
  })
  on('turn.complete', ($, e) => e as never)

  await $.command.run({ command: 'ksync', args: 'pick KA9' } as never)
  await $.turn.complete({ reason: 'answer', answer: 'We will drop deploy alerts.', text: '', turnId: 't1' } as never)
  await clock.advance(10)

  expect(calls).toBe(0)
  const status = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(status.text).toContain('Nothing waiting to be synced.')
})

const HINT = { component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } as never } as const

test('the chip sits on the hint line in Karea green once synced, amber when behind', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
  mock.env(on, { HOME: '/tmp' })
  on('tool.call', ($, e) => (e.tool === 'Bash' ? shell(e.command) : { result: '', text: '' }) as never)
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as never)

  await $.command.run({ command: 'ksync', args: 'pick KA9' } as never)
  await $.tool.call({ tool: 'mcp__karea__karea_notes_write', action: 'karea_add_note', params: { task: 'KA9', content: 'x' } })

  for (const surface of ['terminal', 'desktop'] as const) {
    const hint = await $.ui.mount({ plugin: 'karea', surface, ...HINT })
    const synced = await hint.find({ type: 'Text', text: /KA9/ })
    expect(synced?.props.color).toBe('#2BD4BD')
    expect(synced?.text).toContain('● KA9 · synced just now')
    await hint.unmount()
  }

  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  const hint = await $.ui.mount({ plugin: 'karea', surface: 'terminal', ...HINT })
  const behind = await hint.find({ type: 'Text', text: /KA9/ })
  expect(behind?.props.color).toBe('warning')
  expect(behind?.text).toContain('◐ KA9 · 1 unsynced')
  await hint.unmount()
})

test('the band defers to the personal karea-sync mod when both are loaded', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
  mock.env(on, { CLAUDE_CODE_PLUGIN_DIRS: '/Users/x/.claude/mods/tldr-guard:/Users/x/.claude/mods/karea-sync' })
  on('tool.call', ($, e) => (e.tool === 'Bash' ? shell(e.command) : { result: '', text: '' }) as never)
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as never)

  await $.command.run({ command: 'ksync', args: 'pick KA9' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git -C . commit -m x' })
  const status = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(status.text).toContain('Not synced yet: committed')
  const band = await $.ui.mount({ plugin: 'karea', surface: 'terminal', ...BAND })
  expect(await band.find({ key: 'sync' })).toBe(undefined)
  await band.unmount()
})

test('a sync counts only once its turn ends, and it re-checks the whole context', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') })
  mock.env(on, { HOME: '/tmp' })
  on('tool.call', ($, e) => (e.tool === 'Bash' ? shell(e.command) : { result: '', text: '' }) as never)
  on('turn.complete', ($, e) => e as never)
  const sent: string[] = []
  on('prompt.submit', ($, e) => { sent.push((e as { text: string }).text); return e as never })

  await $.command.run({ command: 'ksync', args: 'pick KA9' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x && git push' })
  const pane = await $.ui.mount({ plugin: 'karea', surface: 'terminal', component: 'Pane', requestId: 'karea-task', props: { title: 'Karea' } as never })
  await pane.press({ key: 'pane-sync' })
  await pane.unmount()
  const prompt = sent.find(t => t.startsWith('Update Karea task KA9')) ?? ''
  expect(prompt).toContain('Re-read every Context entry')
  expect(prompt).toContain('Add a note only if something big happened')
  expect(prompt).not.toContain('and add a note')

  // The first write of the sync, on one entry only: not synced yet.
  await $.tool.call({ tool: 'mcp__karea__karea_tasks_write', action: 'karea_set_context', params: { task: 'KA9', title: 'Plan', content: 'Pushed' } } as never)
  const mid = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(mid.text).toContain('Not synced yet')

  // The sync turn ends: now it is.
  await $.turn.complete({ reason: 'answer', answer: 'Synced KA9.', text: '', turnId: 't1' } as never)
  const after = await $.command.run({ command: 'ksync', args: 'status' } as never)
  expect(after.text).toContain('Nothing waiting to be synced.')
})
