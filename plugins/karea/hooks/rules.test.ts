import { expect, test } from 'claude-code/testing'

import {
  addPending,
  changeLine,
  chip,
  contextChanges,
  humanChanges,
  isKareaWrite,
  parseCommand,
  parseFindings,
  syncPrompt as syncFor,
  trackOpenDecisions,
  analyzePrompt,
  progressEvents,
  receipt,
  rereadContext,
  recapText,
  shortIdFromResult,
  taskRefOf,
} from './rules'

const COMMITTED = '[main 3c3b8de] Fix login\n 1 file changed'
const PUSHED = 'To github.com:acme/api.git\n   e1f182b..3c3b8de  main -> main'

test('counts commits and pushes only when they succeeded', async () => {
  expect(progressEvents('git add x && git commit -m a && git push', `${COMMITTED}\n${PUSHED}`)).toEqual(['committed', 'pushed'])
  expect(progressEvents('git commit -m a', 'On branch main\nnothing to commit, working tree clean')).toEqual([])
  expect(progressEvents('git push', 'Everything up-to-date')).toEqual([])
  expect(progressEvents('git push', ' ! [rejected]        main -> main (fetch first)\nerror: failed to push')).toEqual([])
  expect(progressEvents('git push -u origin feat', ' * [new branch]      feat -> feat')).toEqual(['pushed'])
  expect(progressEvents('git status --short', '')).toEqual([])
})

test('deploys are not progress unless a preset asks for them', async () => {
  const deploy = 'sf project deploy start -o acme-dev2 -d src'
  expect(progressEvents(deploy, 'Status: Succeeded', 'git')).toEqual([])
  expect(progressEvents(deploy, 'Status: Succeeded', 'salesforce')).toEqual(['deployed to acme-dev2'])
  expect(progressEvents(deploy, 'Status: Failed\nComponent Failures [2]', 'salesforce')).toEqual([])
  expect(progressEvents(`${deploy} 2>&1 | tail -20`, 'Error (1): Deploy failed.', 'salesforce')).toEqual([])
  expect(progressEvents('npx prisma migrate deploy', 'All migrations have been applied', 'general')).toEqual(['ran migrations'])
  expect(progressEvents('make release', '', 'git', 'released=\\bmake release\\b;bad=(')).toEqual(['released'])
})

test('keeps only decisions the developer made and questions for a named outside party', async () => {
  expect(
    parseFindings(
      JSON.stringify({
        decisions: [
          { text: 'Drop deploy alerts', madeBy: 'developer', kind: 'scope', why: 'too noisy', settled: true },
          { text: 'Remove GroupConstants class', madeBy: 'developer', kind: 'solution', why: '', settled: false },
          { text: 'Publish a plugin repo', madeBy: 'assistant', kind: 'solution', why: '' },
          { text: 'Run Knowledge User, SLDS theme, and admin login-as steps', madeBy: 'developer', kind: 'execution', why: '' },
          { text: 'Rename a variable', madeBy: 'developer', kind: 'detail', why: '' },
        ],
        questions: [
          { text: 'Should manual setup steps from build/deploy-scripts/ be removed?', answeredBy: 'developer', party: '' },
          { text: 'Do environment-specific profiles need src-env-specific/?', answeredBy: 'external', party: '' },
          { text: 'Which repo owner should we use?', answeredBy: 'external', party: 'the developer' },
          { text: 'Can the client provide the SSO metadata?', answeredBy: 'external', party: 'Acme client' },
        ],
      }),
    ),
  ).toEqual(['decision: Drop deploy alerts', 'open question for Acme client: Can the client provide the SSO metadata?'])
  expect(parseFindings('{"decisions":["old string format"],"questions":["Should PRs count?"]}')).toEqual([])
  expect(parseFindings('{"decisions":[],"questions":[]}')).toEqual([])
  expect(parseFindings('nothing')).toEqual([])
})

test('tells Karea writes from reads, grouped and legacy tools alike', async () => {
  expect(isKareaWrite('mcp__karea__karea_tasks_write', { action: 'karea_edit_task' })).toBe(true)
  expect(isKareaWrite('mcp__claude_ai_Karea__karea_notes_write', { action: 'karea_add_note' })).toBe(true)
  expect(isKareaWrite('mcp__karea__karea_set_context', {})).toBe(true)
  expect(isKareaWrite('mcp__karea__karea_read', { action: 'karea_view_task' })).toBe(false)
  expect(isKareaWrite('mcp__karea__karea_assistant', { action: 'karea_recap' })).toBe(false)
  expect(isKareaWrite('Bash', { action: 'karea_add_note' })).toBe(false)
})

test('finds the task a Karea call is about', async () => {
  expect(taskRefOf({ action: 'karea_add_note', params: { task: 'KA9', content: 'x' } })).toBe('KA9')
  expect(taskRefOf({ task: 'KA10' })).toBe('KA10')
  expect(taskRefOf({ params: { parent: 'KA11', title: 'sub' } })).toBe('KA11')
  expect(taskRefOf({ params: { name: 'new' } })).toBe(undefined)
  expect(shortIdFromResult('Task created\nShort ID: KA747\nLink: x')).toBe('KA747')
})

test('pending list dedupes and stays short', async () => {
  expect(addPending(['pushed', 'committed'], ['pushed'])).toEqual(['committed', 'pushed'])
  expect(addPending(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], ['i'])).toEqual(['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])
})

test('chip shows the worst state first', async () => {
  const now = 10 * 60000
  expect(chip({ shortid: '', pending: 0, remote: 0, lastSyncAt: 0, now })).toBe('○ no Karea task · /ksync pick')
  expect(chip({ shortid: 'KA9', pending: 2, remote: 1, lastSyncAt: 0, now })).toBe('◆ KA9 · changed in Karea')
  expect(chip({ shortid: 'KA9', pending: 2, remote: 0, lastSyncAt: 0, now })).toBe('◐ KA9 · 2 unsynced')
  expect(chip({ shortid: 'KA9', pending: 0, remote: 0, lastSyncAt: 6 * 60000, now })).toBe('● KA9 · synced 4m ago')
})

test('only human edits after the watermark count as remote changes', async () => {
  const rows = [
    { field: 'status', oldValue: 'in_progress', newValue: 'blocked', mode: 'user', createdAt: '2026-10-07T10:05:00Z' },
    { field: 'status', oldValue: 'open', newValue: 'in_progress', mode: 'mcp', createdAt: '2026-10-07T10:06:00Z' },
    { field: 'note_added', oldValue: null, newValue: 'waiting on design review', mode: 'user', createdAt: '2026-10-07T10:07:00Z' },
    { field: 'priority', oldValue: '3', newValue: '1', mode: 'user', createdAt: '2026-10-07T09:00:00Z' },
    { field: 'closedById', oldValue: null, newValue: 'u1', mode: 'user', createdAt: '2026-10-07T10:08:00Z' },
  ]
  const since = Date.parse('2026-10-07T10:00:00Z')
  expect(humanChanges(rows, since).map(changeLine)).toEqual([
    'status in_progress → blocked',
    'new note: "waiting on design review"',
  ])
  expect(
    contextChanges(
      [
        { title: 'Plan', updatedAt: since + 1, lastEditedMode: 'user' },
        { title: 'Findings', updatedAt: since + 1, lastEditedMode: 'mcp' },
      ],
      since,
    ),
  ).toEqual(['context "Plan" edited'])
})

test('receipts say what was written', async () => {
  expect(receipt('karea_set_context', { params: { task: 'KA9', title: 'Findings', context: '...' } })).toBe('context Findings')
  expect(receipt('karea_add_note', { params: { task: 'KA9', content: 'Deployed to staging' } })).toBe('note "Deployed to staging"')
  expect(receipt('karea_edit_task', { params: { task: 'KA9', status: 'review', note: 'ready' } })).toBe('task · status review · note "ready"')
})

test('parses /karea arguments', async () => {
  expect(parseCommand('pick KA9')).toEqual({ verb: 'pick', ref: 'KA9' })
  expect(parseCommand('KA9')).toEqual({ verb: 'pick', ref: 'KA9' })
  expect(parseCommand('')).toEqual({ verb: 'status' })
  expect(parseCommand('sync all')).toEqual({ verb: 'sync', isAll: true })
  expect(parseCommand('sync')).toEqual({ verb: 'sync', isAll: false })
  expect(parseCommand('frobnicate')).toEqual({ verb: 'help' })
})

test('recap lists every task with its state', async () => {
  const text = recapText(
    [
      { shortid: 'KA9', title: 'Mods', pending: [] },
      { shortid: 'KA10', title: 'Player', pending: ['committed', 'pushed'] },
    ],
    'KA9',
  )
  expect(text).toContain('● KA9 (active) Mods  synced')
  expect(text).toContain('◐ KA10 Player  2 pending (committed, pushed)')
  expect(text).toContain('/ksync sync all to sync 1 task.')
})

test('remembers unsettled decisions across a long back-and-forth until one is settled', async () => {
  const raised = trackOpenDecisions(
    [],
    JSON.stringify({ decisions: [{ text: 'Remove GroupConstants class', madeBy: 'developer', kind: 'solution', settled: false }] }),
  )
  expect(raised).toEqual([{ text: 'Remove GroupConstants class', age: 0 }])
  let open = raised
  for (let i = 0; i < 12; i += 1) open = trackOpenDecisions(open, '{"decisions":[],"questions":[]}')
  expect(open).toEqual([{ text: 'Remove GroupConstants class', age: 12 }])
  const settled = trackOpenDecisions(
    open,
    JSON.stringify({ decisions: [{ text: 'Remove GroupConstants, inline the names', madeBy: 'developer', kind: 'solution', settled: true, resolves: 'Remove GroupConstants class' }] }),
  )
  expect(settled).toEqual([])
  let stale = raised
  for (let i = 0; i < 41; i += 1) stale = trackOpenDecisions(stale, '{}')
  expect(stale).toEqual([])
  expect(analyzePrompt('yes', 'Removed it.', undefined, open)).toContain('OPEN DECISIONS (context only)\n- Remove GroupConstants class')
})

test('settling a known open decision alerts even if the settle turn looks like a go-ahead', async () => {
  const reply = JSON.stringify({
    decisions: [{ text: 'Remove GroupConstants, inline names', madeBy: 'developer', kind: 'execution', settled: true, resolves: 'Remove GroupConstants class' }],
  })
  expect(parseFindings(reply)).toEqual([])
  expect(parseFindings(reply, [{ text: 'Remove GroupConstants class' }])).toEqual(['decision: Remove GroupConstants, inline names'])
})

test('the sync prompt never asks for open questions that were not listed', async () => {
  const decisionOnly = syncFor('KA9', ['decision: Replace OwnerId with OwnerName__c formula field'])
  expect(decisionOnly).toContain("Write each listed decision to the task's Decisions context entry")
  expect(decisionOnly).not.toContain('Create a Karea open question')
  expect(decisionOnly).toContain('Do NOT create any other Karea open questions')
  expect(decisionOnly).toContain('"Loose ends" context entry')

  const pushOnly = syncFor('KA9', ['pushed'])
  expect(pushOnly).not.toContain('Decisions context entry')
  expect(pushOnly).not.toContain('Create a Karea open question')

  const withQuestion = syncFor('KA9', ['decision: Drop the legacy queue', 'open question for Acme client: Will UAT be refreshed before go-live?'])
  expect(withQuestion).toContain('For the listed open question (1), ask me first (one AskUserQuestion)')
  expect(withQuestion).toContain('create only the ones I approve, and no others')
  expect(withQuestion).not.toContain('Create a Karea open question')
})

test('a question for later needs real investigation and a reason it will come back', async () => {
  const reply = JSON.stringify({
    questions: [
      { text: 'Why does the nightly ETL skip cases created around midnight?', answeredBy: 'future', tried: 'logs, timezone settings, batch scope', recurs: 'happens every month-end close' },
      { text: "Why doesn't the Case View override activate Case_Record_Page?", answeredBy: 'future', tried: '', recurs: 'may come back' },
      { text: 'Provide a Bitbucket token?', answeredBy: 'future', tried: 'none', recurs: '' },
    ],
  })
  expect(parseFindings(reply)).toEqual(['open question for later: Why does the nightly ETL skip cases created around midnight?'])
})

test('edits a person makes through Karea AI count as changed in Karea, the session own writes do not', () => {
  const since = Date.parse('2026-10-07T10:00:00Z')
  const rows = [
    { field: 'status', oldValue: 'open', newValue: 'blocked', mode: 'ai', createdAt: '2026-10-07T10:05:00Z' },
    { field: 'priority', oldValue: '3', newValue: '1', mode: 'mcp', createdAt: '2026-10-07T10:06:00Z' },
  ]
  expect(humanChanges(rows, since).map(changeLine)).toEqual(['status open → blocked'])
  expect(
    contextChanges(
      [
        { title: 'Plan', updatedAt: since + 1000, lastEditedMode: 'ai' },
        { title: 'Findings', updatedAt: since + 1000, lastEditedMode: 'mcp' },
      ],
      since,
    ),
  ).toEqual(['context "Plan" edited'])
})

test('deletes and unlinks count as Karea writes; the re-read names the exact calls', () => {
  expect(isKareaWrite('mcp__karea__karea_delete', { action: 'karea_delete_note', params: {} })).toBe(true)
  expect(isKareaWrite('mcp__karea__karea_read', { action: 'karea_view_task', params: {} })).toBe(false)
  const text = rereadContext('KA9', 'The user was away for 50 minutes.')
  for (const call of ['karea_read', 'karea_view_task', 'karea_get_context', 'karea_list_notes', 'karea_list_questions']) expect(text).toContain(call)
})
