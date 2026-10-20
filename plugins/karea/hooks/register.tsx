import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActiveTask, ContextAge, HistoryRow, Touched } from '../types'
import {
  AWAY_MS,
  HELP,
  IDLE_POLL_MS,
  addEvents,
  addPending,
  ago,
  changeLine,
  TONE_COLORS,
  chip,
  chipView,
  ASK_MEETING,
  NO_MEETING,
  meetingLabel,
  parseMeetings,
  pickMeeting,
  questionIds,
  linkInstruction,
  freeMeetingAnswerInstruction,
  linkedNotice,
  kareaParams,
  contextAgesOf,
  diffSnapshots,
  mcpText,
  parseContextText,
  parseViewTask,
  snapshotOf,
  contextChanges,
  freshness,
  humanChanges,
  isKareaWrite,
  isShortId,
  kareaAction,
  markSynced,
  parseCommand,
  pickContext,
  progressEvents,
  recapText,
  receipt,
  rereadContext,
  briefContext,
  shortIdFromResult,
  staleSince,
  syncAllPrompt,
  syncPrompt,
  ANALYZE_SYSTEM,
  analyzePrompt,
  parseFindings,
  trackOpenDecisions,
  readsTask,
  taskRefsOf,
  writeTouchesTask,
  upsertTouched,
  changeKey,
  changesWindow,
  isUnknownAction,
  parseTaskChanges,
  personChanges,
  statusFromChanges,
  taskChangeLine,
  subtaskRefusal,
  subtaskAsk,
  subtaskAnswerContext,
  CLOSE_ALL,
  CLOSE_ONLY,
  KEEP_OPEN,
} from './rules'
import type { Meeting, Preset, ViewedTask } from './rules'

type Api = { baseUrl: string; apiKey: string }

class KareaError extends Error {}

async function call<T>(
  $: EngineInterface,
  api: Api,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await $.http.fetch(`${api.baseUrl.replace(/\/+$/, '')}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${api.apiKey}`, 'Content-Type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const parsed = JSON.parse(res.text) as { error?: string }
      if (parsed.error) message = parsed.error
    } catch {
      // body was not JSON
    }
    throw new KareaError(message)
  }
  return JSON.parse(res.text) as T
}

type ContextResponse = {
  id: string
  title: string
  entries: { title: string; updatedAt: string; lastEditedMode: string }[]
}

async function getContext($: EngineInterface, api: Api, ref: string) {
  const data = await call<ContextResponse>($, api, `/api/tasks/context?task=${encodeURIComponent(ref)}`)
  const entries: ContextAge[] = data.entries.map(entry => ({
    title: entry.title,
    updatedAt: Date.parse(entry.updatedAt),
    lastEditedMode: entry.lastEditedMode,
  }))
  return { id: data.id, title: data.title, entries }
}

async function getTask($: EngineInterface, api: Api, id: string) {
  return call<{ id: string; title: string; status: string; displayId?: string | null }>($, api, `/api/tasks/${id}`)
}

async function getHistory($: EngineInterface, api: Api, id: string) {
  return call<HistoryRow[]>($, api, `/api/tasks/${id}/history`)
}

async function setStatus($: EngineInterface, api: Api, id: string, status: string) {
  return call<unknown>($, api, `/api/tasks/${id}`, { method: 'PATCH', body: { status } })
}

async function linkSession($: EngineInterface, api: Api, id: string, sessionId: string, label: string) {
  return call<unknown>($, api, `/api/tasks/${id}/ai-sessions`, {
    method: 'POST',
    body: { provider: 'claude-code', sessionId, label },
  })
}

function taskUrl(api: Api, id: string): string {
  return `${api.baseUrl.replace(/\/+$/, '')}/dashboard/task/${id}`
}

const PANE = 'karea-task'

const active = atom({ plugin: 'karea', key: 'active' } as const, null)
const pending = atom({ plugin: 'karea', key: 'pending' } as const, [])
const events = atom({ plugin: 'karea', key: 'events' } as const, [])
const lastSyncAt = atom({ plugin: 'karea', key: 'lastSyncAt' } as const, 0)
const remote = atom({ plugin: 'karea', key: 'remote' } as const, null)
const watermark = atom({ plugin: 'karea', key: 'watermark' } as const, 0)
const contextAges = atom({ plugin: 'karea', key: 'contextAges' } as const, [])
const touched = atom({ plugin: 'karea', key: 'touched' } as const, [])
const lastPromptAt = atom({ plugin: 'karea', key: 'lastPromptAt' } as const, 0)
const needsReread = atom({ plugin: 'karea', key: 'needsReread' } as const, false)
const clearArmed = atom({ plugin: 'karea', key: 'clearArmed' } as const, false)
const snapshot = atom({ plugin: 'karea', key: 'snapshot' } as const, null)
const chipNow = atom({ plugin: 'karea', key: 'chipNow' } as const, null)
const lastPrompt = atom({ plugin: 'karea', key: 'lastPrompt' } as const, '')
const turnWrote = atom({ plugin: 'karea', key: 'turnWrote' } as const, false)
// KA813: a sync turn is under way; its Karea writes count only once the turn ends.
const syncing = atom({ plugin: 'karea', key: 'syncing' } as const, false)
const earlier = atom({ plugin: 'karea', key: 'earlier' } as const, null)
const openDecisions = atom({ plugin: 'karea', key: 'openDecisions' } as const, [])
const lastCheckAt = atom({ plugin: 'karea', key: 'lastCheckAt' } as const, 0)
const seenChanges = atom({ plugin: 'karea', key: 'seenChanges' } as const, [])
// Picked from KAREA_TASK at start: the first prompt carries the brief (Karea Connect sends none when this mod is on).
const briefPending = atom({ plugin: 'karea', key: 'briefPending' } as const, false)

// The task picked in each session, kept in the plugin's store so a closed and resumed session gets it back.
const SESSION_TASKS = 'sessionTasks'
const MAX_SESSIONS = 200
type SavedTask = ActiveTask | 'off'

async function currentSessionId($: EngineInterface): Promise<string> {
  try {
    return await $.session.id()
  } catch {
    return ''
  }
}

async function savedTask($: EngineInterface, id: string): Promise<SavedTask | undefined> {
  if (id === '') return undefined
  try {
    const all = (await $.store.get(SESSION_TASKS)) as Record<string, SavedTask> | undefined
    return all?.[id]
  } catch {
    return undefined
  }
}

async function saveTask($: EngineInterface, task: SavedTask) {
  const id = await currentSessionId($)
  if (id === '') return
  try {
    const all = ((await $.store.get(SESSION_TASKS)) as Record<string, SavedTask> | undefined) ?? {}
    const { [id]: _previous, ...rest } = all
    const kept = Object.entries(rest).slice(-(MAX_SESSIONS - 1))
    await $.store.set(SESSION_TASKS, { ...Object.fromEntries(kept), [id]: task })
  } catch {
    // remembering the task is a convenience
  }
}

type Config = {
  api: Api
  hasApi: boolean
  preset: Preset
  extraPatterns: string
  pollMs: number
  showReceipts: boolean
  detectDecisions: boolean
  mcpServer: string
  writeStatusFile: boolean
}

let cfg: Config = {
  api: { baseUrl: 'https://karea.app', apiKey: '' },
  hasApi: false,
  preset: 'git',
  extraPatterns: '',
  pollMs: 300000,
  showReceipts: true,
  detectDecisions: false,
  mcpServer: '',
  writeStatusFile: false,
}

async function refreshChip($: EngineInterface) {
  const task = await read($, active)
  const input = {
    shortid: task?.shortid ?? '',
    pending: (await read($, pending)).length,
    remote: (await read($, remote))?.lines.length ?? 0,
    lastSyncAt: await read($, lastSyncAt),
    now: await $.clock.now(),
    title: task?.title ?? '',
  }
  const view = chipView(input)
  await update($, chipNow, current =>
    current && current.tone === view.tone && current.mark === view.mark && current.label === view.label
      ? current
      : view,
  )
  const text = chip(input)
  if (!cfg.writeStatusFile) return
  try {
    const home = (await $.env.get('HOME')) ?? ''
    await $.fs.write(`${home}/.claude/karea/status-${await $.session.id()}`, task ? text : '')
  } catch {
    // the status file is a convenience
  }
}

async function rememberTouched($: EngineInterface) {
  const task = await read($, active)
  if (!task) return
  const entry: Touched = { shortid: task.shortid, title: task.title, pending: await read($, pending) }
  await update($, touched, list => upsertTouched(list, entry))
}

/** The active task is up to date with this session: nothing pending, every local event synced. */
async function markTaskSynced($: EngineInterface) {
  const now = await $.clock.now()
  await update($, pending, () => [])
  await update($, events, list => markSynced(list))
  await update($, lastSyncAt, () => now)
  await update($, watermark, () => now)
  await update($, clearArmed, () => false)
  await update($, snapshot, () => null)
  await rememberTouched($)
  await refreshChip($)
}

/** KA813: ask Claude to sync the active task, naming the context entries not rewritten this session. */
async function startSync($: EngineInterface, shortid: string) {
  const first = (await read($, events))[0]?.at ?? 0
  const stale = [...staleSince(await read($, contextAges), first)]
  await update($, syncing, () => true)
  await $.prompt.submit({ text: syncPrompt(shortid, await read($, pending), stale), asUser: true }).catch(() => update($, syncing, () => false))
}

async function loadContextAges($: EngineInterface, ref: string) {
  if (!cfg.hasApi) return undefined
  try {
    const data = await getContext($, cfg.api, ref)
    await update($, contextAges, () => data.entries)
    return data
  } catch {
    return undefined
  }
}

const MCP_SERVERS = ['karea', 'claude.ai Karea']
const MEETING_SERVERS = MCP_SERVERS
let QUESTION_MEETING_SETTING = ''
let mcpServerInUse = ''

async function kareaMcpRaw(
  $: EngineInterface,
  tool: string,
  action: string,
  params: Record<string, unknown>,
): Promise<{ text: string; isError: boolean } | null> {
  const candidates = cfg.mcpServer ? [cfg.mcpServer] : mcpServerInUse ? [mcpServerInUse] : MCP_SERVERS
  const failures: string[] = []
  for (const server of candidates) {
    try {
      const result = await $.mcp.call(server, tool, { action, params })
      mcpServerInUse = server
      return { text: mcpText(result), isError: result.isError === true }
    } catch (error) {
      failures.push(`${server}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
  }
  if (tool !== 'karea_read') $.ui.log(`${action} failed: ${failures.join('; ').slice(0, 200)}`)
  return null
}

async function kareaMcp(
  $: EngineInterface,
  tool: string,
  action: string,
  params: Record<string, unknown>,
): Promise<string | undefined | null> {
  const result = await kareaMcpRaw($, tool, action, params)
  if (result === null) return null
  return result.isError ? undefined : result.text
}

// Set once the connected server turns karea_task_changes down; then polls compare snapshots instead.
let taskChangesUnknown = false

// Asks Karea only for what changed since the last check. False when the server does not know the action.
async function pollChanges($: EngineInterface, task: ActiveTask, now: number): Promise<boolean> {
  const ref = task.id || task.shortid
  const minutes = changesWindow(await read($, lastCheckAt), now)
  if (minutes === undefined) {
    const viewed = await kareaMcp($, 'karea_read', 'karea_view_task', { task: ref })
    const found = viewed ? parseViewTask(viewed) : undefined
    if (!found) return true
    await update($, active, current =>
      current ? { ...current, id: found.id, title: found.title || current.title, status: found.status || current.status } : current,
    )
    await update($, lastCheckAt, () => now)
    await update($, seenChanges, () => [])
    return true
  }
  const result = await kareaMcpRaw($, 'karea_read', 'karea_task_changes', { task: ref, sinceMinutes: minutes })
  if (result === null) return true
  if (isUnknownAction(result.text)) {
    taskChangesUnknown = true
    return false
  }
  if (result.isError) return true
  const rows = parseTaskChanges(result.text)
  const fresh = personChanges(rows, await read($, watermark), await read($, seenChanges))
  await update($, seenChanges, list => [...list, ...rows.map(changeKey).filter(key => !list.includes(key))].slice(-100))
  await update($, lastCheckAt, () => now)
  const status = statusFromChanges(rows)
  if (status) await update($, active, current => (current ? { ...current, status } : current))
  await flagRemote($, task.shortid, fresh.map(taskChangeLine), now)
  return true
}

async function mcpSnapshot($: EngineInterface, ref: string) {
  const viewed = await kareaMcp($, 'karea_read', 'karea_view_task', { task: ref })
  if (viewed === null) return null
  const task: ViewedTask | undefined = viewed ? parseViewTask(viewed) : undefined
  if (!task) return undefined
  const context = await kareaMcp($, 'karea_read', 'karea_get_context', { task: task.id })
  const entries = context ? parseContextText(context) : []
  await update($, contextAges, () => contextAgesOf(entries))
  return { task, snap: snapshotOf(task, entries) }
}

async function flagRemote($: EngineInterface, shortid: string, changes: string[], now: number) {
  if (changes.length === 0) return
  const previous = (await read($, remote))?.lines ?? []
  const lines = [...previous, ...changes.filter(line => !previous.includes(line))].slice(-6)
  await update($, remote, () => ({ at: now, lines }))
  await update($, watermark, () => now)
  $.ui.toast(`${shortid} changed in Karea: ${changes[0]}${changes.length > 1 ? ` (+${changes.length - 1})` : ''}`)
  await refreshChip($)
}

// KA995: the session has the task's latest state, so the band and the chip stop asking.
async function clearRemote($: EngineInterface) {
  const now = await $.clock.now()
  await update($, remote, () => null)
  await update($, watermark, () => now)
  await refreshChip($)
}

async function activate($: EngineInterface, ref: string, setInProgress: boolean): Promise<string> {
  const previous = await read($, active)
  const leftBehind = previous && previous.shortid !== ref ? await read($, pending) : []
  await rememberTouched($)

  let task: ActiveTask = { shortid: ref, id: '', title: '', status: '' }
  const lines: string[] = []
  if (cfg.hasApi) {
    const data = await loadContextAges($, ref)
    if (!data) return `Could not find ${ref} in Karea. Check the ID and your API key.`
    const full = await getTask($, cfg.api, data.id).catch(() => undefined)
    task = { shortid: full?.displayId || ref, id: data.id, title: data.title, status: full?.status ?? '' }
    if (setInProgress && task.status !== 'in_progress') {
      await setStatus($, cfg.api, task.id, 'in_progress').catch(() => undefined)
      lines.push(`status ${task.status || 'open'} → in progress`)
      task = { ...task, status: 'in_progress' }
    }
    const linked = await linkSession($, cfg.api, task.id, await $.session.id(), 'Claude Code').then(
      () => true,
      () => false,
    )
    if (linked) lines.push('session linked')
    const ages = await read($, contextAges)
    const at = await $.clock.now()
    if (ages.length > 0)
      lines.push(`context: ${ages.map(entry => `${entry.title} (${ago(at - entry.updatedAt)})`).join(' · ')}`)
  } else {
    const found = await mcpSnapshot($, ref)
    if (found === undefined)
      return `Could not find ${ref} in Karea. Check the ID, and that the Karea MCP server is connected (/mcp).`
    if (found === null) {
      await update($, contextAges, () => [])
      await update($, snapshot, () => null)
    } else {
      task = {
        shortid: found.task.shortid || ref,
        id: found.task.id,
        title: found.task.title,
        status: found.task.status,
      }
      if (setInProgress) {
        const edited = await kareaMcp($, 'karea_tasks_write', 'karea_edit_task', {
          task: task.id,
          ...(task.status === 'in_progress' ? {} : { status: 'in_progress' }),
          aiSessionId: await $.session.id(),
          toolType: 'claude-code',
          sessionLabel: 'Claude Code',
        })
        if (typeof edited === 'string') {
          if (task.status !== 'in_progress') lines.push(`status ${task.status || 'open'} → in progress`)
          lines.push('session linked')
          task = { ...task, status: 'in_progress' }
        }
      }
      const fresh = setInProgress ? await mcpSnapshot($, task.id) : found
      await update($, snapshot, () => fresh?.snap ?? found.snap)
      const ages = await read($, contextAges)
      const at = await $.clock.now()
      if (ages.length > 0)
        lines.push(`context: ${ages.map(entry => `${entry.title} (${ago(at - entry.updatedAt)})`).join(' · ')}`)
    }
  }

  const now = await $.clock.now()
  await update($, active, () => task)
  const carried = (await read($, touched)).find(item => item.shortid === task.shortid)?.pending ?? []
  await update($, pending, () => carried)
  await update($, events, () => [])
  await update($, lastSyncAt, () => 0)
  await update($, remote, () => null)
  await update($, watermark, () => now)
  await update($, lastCheckAt, () => (task.id ? now : 0))
  await update($, seenChanges, () => [])
  await update($, lastPromptAt, previous => Math.max(previous, now))
  await rememberTouched($)
  await refreshChip($)
  await saveTask($, task)

  const head = `Active: ${task.shortid}${task.title ? ` ${task.title}` : ''}`
  const warn =
    leftBehind.length > 0 && previous
      ? `\n${previous.shortid} still has ${leftBehind.length} unsynced event${leftBehind.length === 1 ? '' : 's'} (${leftBehind.join(', ')}). /ksync recap lists it.`
      : ''
  return `${head}${lines.length > 0 ? `\n  ${lines.join('\n  ')}` : ''}${warn}`
}

async function poll($: EngineInterface) {
  const task = await read($, active)
  if (!task) return
  const now = await $.clock.now()
  if (now - (await read($, lastPromptAt)) > IDLE_POLL_MS) return

  if (!cfg.hasApi) {
    if (!taskChangesUnknown && (await pollChanges($, task, now))) return
    const fresh = await mcpSnapshot($, task.id || task.shortid)
    if (!fresh) return
    await update($, active, current =>
      current
        ? { ...current, id: fresh.task.id, title: fresh.task.title || current.title, status: fresh.task.status }
        : current,
    )
    const before = await read($, snapshot)
    await update($, snapshot, () => fresh.snap)
    if (before) await flagRemote($, task.shortid, diffSnapshots(before, fresh.snap), now)
    return
  }

  if (!task.id) return
  const since = await read($, watermark)
  try {
    const [rows, ctx] = await Promise.all([getHistory($, cfg.api, task.id), loadContextAges($, task.id)])
    const changes = [...humanChanges(rows, since).map(changeLine), ...contextChanges(ctx?.entries ?? [], since)]
    const status = rows.find(row => row.field === 'status' && Date.parse(row.createdAt) > since)?.newValue
    if (status) await update($, active, current => (current ? { ...current, status } : current))
    await flagRemote($, task.shortid, changes, now)
  } catch {
    // offline or Karea unreachable: try again next period
  }
}

async function analyzeTurn($: EngineInterface, prompt: string, answer: string) {
  const context = await read($, earlier)
  const openBefore = await read($, openDecisions)
  await update($, earlier, () => ({ prompt: prompt.slice(0, 1500), answer: answer.slice(0, 3000) }))
  const reply = await $.model
    .complete({
      model: 'haiku',
      system: ANALYZE_SYSTEM,
      prompt: analyzePrompt(prompt, answer, context ?? undefined, openBefore),
      maxTokens: 300,
      timeoutMs: 30000,
    })
    .catch(() => undefined)
  if (!reply) return
  if (reply?.isAnswered) await update($, openDecisions, open => trackOpenDecisions(open, reply.text))
  if (!reply.isAnswered || (await read($, turnWrote)) || !(await read($, active))) return
  const found = parseFindings(reply.text, openBefore)
  if (found.length === 0) return
  const now = await $.clock.now()
  await update($, pending, list => addPending(list, found))
  await update($, events, list => addEvents(list, found, now))
  await rememberTouched($)
  await refreshChip($)
}

async function kareaSyncLoaded($: EngineInterface): Promise<boolean> {
  const dirs = (await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? ''
  return /(^|[/:])karea-sync(:|$)/.test(dirs)
}

async function upcomingMeetings($: EngineInterface): Promise<Meeting[]> {
  const now = await $.clock.now()
  const to = new Date(now + 21 * 86400000).toISOString()
  for (const server of MEETING_SERVERS) {
    try {
      // KA990: every meeting that has not ended, so one under way today is offered too.
      const result = await $.mcp.call(server, 'karea_read', { action: 'karea_list_meetings', params: { scope: 'upcoming', to } })
      if (result.isError) return []
      return parseMeetings(result.content.map(block => block.text ?? '').join('\n'))
    } catch {
      continue
    }
  }
  return []
}

async function linkQuestionToMeeting($: EngineInterface, meetingId: string, questionId: string): Promise<string> {
  const reasons: string[] = []
  for (const server of MEETING_SERVERS) {
    try {
      const result = await $.mcp.call(server, 'karea_meetings_write', {
        action: 'karea_link_question_to_meeting',
        params: { meetingId, questionId },
      })
      if (!result.isError) return ''
      reasons.push(`${server}: ${result.content.map(block => block.text ?? '').join(' ').slice(0, 160)}`)
    } catch (error) {
      reasons.push(`${server}: ${error instanceof Error ? error.message.slice(0, 160) : 'call failed'}`)
    }
  }
  return reasons.join('; ') || 'no Karea MCP server answered'
}

async function meetingForQuestion($: EngineInterface, tool: string, input: Record<string, unknown>) {
  if (kareaAction(tool, input) !== 'karea_create_question') return undefined
  const params = kareaParams(input)
  const project = typeof params.projectId === 'string' ? params.projectId : ''
  return chooseMeeting($, QUESTION_MEETING_SETTING, project)
}

async function linkCreatedQuestion(
  $: EngineInterface,
  meeting: Meeting | { answer: string } | undefined,
  resultText: string | undefined,
): Promise<string | undefined> {
  if (!meeting) return undefined
  const question = questionIds(resultText)
  if (!question) return undefined
  if ('answer' in meeting) return freeMeetingAnswerInstruction(question.shortid, question.id, meeting.answer)
  const failure = await linkQuestionToMeeting($, meeting.id, question.id)
  if (failure === '') {
    $.ui.log(`✓ ${question.shortid} linked to ${meetingLabel(meeting)}`)
    return linkedNotice(question.shortid, meetingLabel(meeting))
  }
  $.ui.log(`${question.shortid}: could not link it to ${meetingLabel(meeting)} (${failure}); asking Claude to link it`)
  return linkInstruction(question.shortid, question.id, meeting.id, meetingLabel(meeting))
}

async function chooseMeeting($: EngineInterface, setting: string, project: string): Promise<Meeting | { answer: string } | undefined> {
  if (setting.trim().toLowerCase() === 'none') return undefined
  const meetings = await upcomingMeetings($)
  if (setting.trim() !== '') return pickMeeting(meetings, setting, project)
  const seen = new Set<string>()
  const next = meetings.filter(m => !seen.has(m.title) && (seen.add(m.title), true)).slice(0, 3)
  if (next.length === 0) return undefined
  const labels = next.map(meetingLabel)
  try {
    const answer = await $.ui.ask(ASK_MEETING, { options: [...labels, NO_MEETING], header: 'Meeting' })
    const picked = next[labels.indexOf(answer)]
    if (picked) return picked
    return answer && answer !== NO_MEETING && answer.trim() ? { answer: answer.trim() } : undefined
  } catch {
    return undefined
  }
}

// Session start: the task this session had before it was closed, else the one Karea Connect started it for.
async function restoreTask($: EngineInterface) {
  const saved = await savedTask($, await currentSessionId($))
  if (saved === 'off') return
  const current = await read($, active)
  const now = await $.clock.now()
  if (saved) {
    if (current?.shortid === saved.shortid) return
    const carried = (await read($, touched)).find(item => item.shortid === saved.shortid)?.pending ?? []
    await update($, active, () => saved)
    await update($, pending, () => carried)
    await update($, remote, () => null)
    await update($, watermark, () => now)
    await update($, lastCheckAt, () => 0)
    return
  }
  if (current) return
  const ref = ((await $.env.get('KAREA_TASK')) ?? '').trim().toUpperCase()
  if (!isShortId(ref)) return
  await update($, active, () => ({ shortid: ref, id: '', title: '', status: '' }))
  await update($, briefPending, () => true)
  $.clock.after(0, () => void autoPick($, ref))
}

async function autoPick($: EngineInterface, ref: string) {
  const text = await activate($, ref, false)
  const task = await read($, active)
  if (text.startsWith('Could not find') || !task) {
    await saveTask($, { shortid: ref, id: '', title: '', status: '' })
    return
  }
  $.ui.log(`Karea task ${task.shortid}${task.title ? ` ${task.title}` : ''} is active in this session (from Karea Connect).`)
}

export const register: Register = (on, options) => {
  QUESTION_MEETING_SETTING = String(options.questionMeeting ?? '')

  const api: Api = { baseUrl: String(options.baseUrl ?? 'https://karea.app'), apiKey: String(options.apiKey ?? '') }
  cfg = {
    api,
    hasApi: api.apiKey.trim() !== '',
    preset: String(options.preset ?? 'git') as Preset,
    extraPatterns: String(options.extraPatterns ?? ''),
    pollMs: Math.max(60, Number(options.pollSeconds ?? 300)) * 1000,
    showReceipts: options.receipts !== false,
    detectDecisions: options.detectDecisions === true,
    mcpServer: String(options.mcpServer ?? '').trim(),
    writeStatusFile: options.statusFile === true,
  }
  const { hasApi, preset, extraPatterns, pollMs, showReceipts } = cfg

  on('session.start', async ($, e, next) => {
    await $.command
      .register({
        name: 'ksync',
        description: 'Karea task sync: pick, status, sync, review, pane, recap, off',
        argumentHint: '[pick KA123 | status | sync [all] | review | pane | recap | off]',
      })
      .catch(() => $.ui.log('karea: /ksync is taken by another command here; use the band and pane instead.'))
    $.clock.every(pollMs, () => void poll($))
    $.clock.every(60000, () => void refreshChip($))
    $.ui.status(undefined)
    await update($, pending, list => list.filter(item => !item.startsWith('open question:')))
    await restoreTask($)
    await refreshChip($)
    return next(e)
  })

  on('command.run', { command: 'ksync' }, async ($, e) => {
    const cmd = parseCommand(e.args)
    const task = await read($, active)

    if (cmd.verb === 'help') return { text: HELP }

    if (cmd.verb === 'pick') {
      const text = await activate($, cmd.ref, true)
      const picked = await read($, active)
      return picked ? { text, context: [pickContext(picked.shortid, picked.id !== '')] } : { text }
    }

    if (cmd.verb === 'off') {
      await rememberTouched($)
      await update($, active, () => null)
      await update($, pending, () => [])
      await update($, remote, () => null)
      await refreshChip($)
      await saveTask($, 'off')
      return { text: 'No active Karea task.' }
    }

    if (cmd.verb === 'recap') {
      await rememberTouched($)
      return { text: recapText(await read($, touched), task?.shortid ?? '') }
    }

    if (cmd.verb === 'sync') {
      if (cmd.isAll) {
        await rememberTouched($)
        const behind = (await read($, touched)).filter(item => item.pending.length > 0)
        if (behind.length === 0) return { text: 'Every Karea task touched in this session is synced.' }
        await update($, syncing, () => true)
        void $.prompt.submit({ text: syncAllPrompt(behind), asUser: true })
        return { text: `Syncing ${behind.map(item => item.shortid).join(', ')}.` }
      }
      if (!task) return { text: 'No active Karea task. Run /ksync pick KA123 first.' }
      await startSync($, task.shortid)
      return { text: `Syncing ${task.shortid}.` }
    }

    if (cmd.verb === 'review') {
      if (!task) return { text: 'No active Karea task.' }
      if (!hasApi) {
        const edited = await kareaMcp($, 'karea_tasks_write', 'karea_edit_task', {
          task: task.id || task.shortid,
          status: 'review',
        })
        if (typeof edited !== 'string') {
          return {
            text: `Asking Claude to set ${task.shortid} to review.`,
            context: [`Set Karea task ${task.shortid} to status review.`],
          }
        }
        await update($, snapshot, () => null)
        await update($, active, current => (current ? { ...current, status: 'review' } : current))
        return { text: `${task.shortid} is in review.` }
      }
      if (!task.id) return { text: `Run /ksync pick ${task.shortid} first.` }
      await setStatus($, api, task.id, 'review')
      await update($, active, current => (current ? { ...current, status: 'review' } : current))
      return { text: `${task.shortid} is in review.` }
    }

    if (cmd.verb === 'pane') {
      if (task && hasApi) await loadContextAges($, task.id || task.shortid)
      else if (task) await mcpSnapshot($, task.id || task.shortid)
      await $.ui.open({ id: PANE, title: 'Karea' })
      return { text: 'Karea pane opened.' }
    }

    if (!task) return { text: 'No active Karea task. Run /ksync pick KA123.' }
    const list = await read($, pending)
    const changes = (await read($, remote))?.lines ?? []
    const lines = [
      `${task.shortid} ${task.title}${task.status ? ` · ${task.status}` : ''}`,
      list.length > 0 ? `Not synced yet: ${list.join(', ')}` : 'Nothing waiting to be synced.',
      ...(changes.length > 0 ? [`Changed in Karea: ${changes.join('; ')}`] : []),
      ...(task.id ? [taskUrl(api, task.id)] : []),
    ]
    return { text: lines.join('\n') }
  })

  on('command.run', { command: 'clear' }, async ($, e, next) => {
    const task = await read($, active)
    const list = await read($, pending)
    if (!task || list.length === 0 || (await read($, clearArmed))) {
      await update($, clearArmed, () => false)
      return next(e)
    }
    await update($, clearArmed, () => true)
    return {
      text: `${task.shortid} has ${list.length} unsynced event${list.length === 1 ? '' : 's'} (${list.join(', ')}). Run /ksync sync first, or /clear again to clear anyway.`,
    }
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await rememberTouched($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    if (kind !== 'composer' && kind !== 'bridge') return next(e)

    await update($, lastPrompt, () => e.text)
    await update($, turnWrote, () => false)
    const now = await $.clock.now()
    const previous = await read($, lastPromptAt)
    const wasCompacted = await read($, needsReread)
    const changes = (await read($, remote))?.lines ?? []
    await update($, lastPromptAt, () => now)
    await update($, needsReread, () => false)

    const task = await read($, active)
    if (!task) return next(e)
    if (await read($, briefPending)) {
      await update($, briefPending, () => false)
      return next({ ...e, context: [...(e.context ?? []), briefContext(task.shortid)] })
    }

    const awayMinutes = previous === 0 ? 0 : Math.round((now - previous) / 60000)
    const reason =
      changes.length > 0
        ? `It was changed in Karea since Claude last read it: ${changes.join('; ')}.`
        : wasCompacted
          ? 'The conversation was just compacted.'
          : awayMinutes * 60000 >= AWAY_MS
            ? `The user was away for ${awayMinutes} minutes.`
            : undefined
    if (reason === undefined) return next(e)

    if (changes.length > 0) {
      await update($, remote, () => null)
      await update($, watermark, () => now)
      await refreshChip($)
    }
    return next({ ...e, context: [...(e.context ?? []), rereadContext(task.shortid, reason)] })
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // KA813: the sync turn is over: only now is the task synced (if Claude wrote to it at all).
    if (e.agentId === undefined && (await read($, syncing))) {
      await update($, syncing, () => false)
      if ((await read($, turnWrote)) && (await read($, active))) await markTaskSynced($)
    }
    if (!cfg.detectDecisions || e.agentId !== undefined || e.reason !== 'answer') return done
    if ((await read($, turnWrote)) || !(await read($, active))) return done
    const prompt = await read($, lastPrompt)
    const { answer } = e
    $.clock.after(0, () => void analyzeTurn($, prompt, answer))
    return done
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    await update($, needsReread, () => true)
    return done
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const meeting = await meetingForQuestion($, String(e.tool), e as unknown as Record<string, unknown>)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const linkContext = await linkCreatedQuestion($, meeting, ran.text)
    if (linkContext) return { ...ran, context: [...(ran.context ?? []), linkContext] }

    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>

    if (isKareaWrite(tool, input)) {
      const action = kareaAction(tool, input) ?? ''
      const refusal = subtaskRefusal(ran.text)
      if (refusal) {
        const answer = await $.ui
          .ask(subtaskAsk(refusal), { options: [CLOSE_ALL, CLOSE_ONLY, KEEP_OPEN], header: 'Subtasks' })
          .catch(() => undefined)
        $.ui.log(`Karea kept "${refusal.title}" open: it has ${refusal.count} open subtask${refusal.count === 1 ? '' : 's'}${answer ? ` (you chose: ${answer})` : ''}.`)
        return { ...ran, context: [...(ran.context ?? []), subtaskAnswerContext(answer, action, tool)] }
      }
      const named = taskRefsOf(input)
      const refs = named.length ? named : [shortIdFromResult(ran.text)].filter((id): id is string => id !== undefined)
      const ref = refs[0]
      let task = await read($, active)

      if (!task && ref && isShortId(ref) && /link_session|doing|edit_task|set_context|add_note/.test(action)) {
        await activate($, ref, false)
        task = await read($, active)
      }

      await update($, turnWrote, () => true)
      const isActive = writeTouchesTask(refs, task)
      if (task && isActive && (await read($, syncing))) {
        // KA813: the first write of a sync is not the sync: wait for the turn to end.
      } else if (task && isActive) {
        await markTaskSynced($)
      } else if (ref) {
        await update($, touched, list => list.map(item => (item.shortid === ref ? { ...item, pending: [] } : item)))
      }

      if (showReceipts && action !== '') $.ui.log(`✓ ${ref ?? task?.shortid ?? 'Karea'} · ${receipt(action, input)}`)
      return ran
    }

    if (readsTask(tool, input, await read($, active)) && (await read($, remote))) await clearRemote($)

    if (e.tool === 'Bash') {
      const out = (ran.result ?? {}) as {
        stdout?: string
        stderr?: string
        backgroundTaskId?: string
        interrupted?: boolean
      }
      if (out.backgroundTaskId || out.interrupted) return ran
      const found = progressEvents(e.command, `${out.stdout ?? ''}\n${out.stderr ?? ''}`, preset, extraPatterns)
      if (found.length > 0 && (await read($, active))) {
        const now = await $.clock.now()
        await update($, pending, list => addPending(list, found))
        await update($, events, list => addEvents(list, found, now))
        await rememberTouched($)
        await refreshChip($)
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const below = await next(e)
    if (await kareaSyncLoaded($)) return below
    const task = await read($, active)
    const view =
      (await read($, chipNow)) ??
      chipView({ shortid: task?.shortid ?? '', pending: 0, remote: 0, lastSyncAt: 0, now: 0, title: task?.title ?? '' })
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexGrow={1}>{below}</Box>
        <Text color={TONE_COLORS[view.tone]}>
          {view.mark} {view.label}
        </Text>
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || e.props.isWorking || (await kareaSyncLoaded($))) return below
    const task = await read($, active)
    if (!task) return below
    const list = await read($, pending)
    const changes = (await read($, remote))?.lines ?? []
    const armed = await read($, clearArmed)
    if (list.length === 0 && changes.length === 0) return below

    const { Box, Text, Button } = $.ui.resolve(e)
    const syncNow = () => void startSync($, task.shortid)
    return (
      <Box flexDirection="column">
        {changes.length > 0 && (
          <Box flexDirection="column">
            <Box flexDirection="row" flexWrap="wrap">
              <Text color="error">◆ {task.shortid} changed in Karea </Text>
              <Text dimColor>Claude reads it with your next message </Text>
              <Button
                key="reread"
                label="Re-read now"
                variant="primary"
                onPress={() =>
                  void clearRemote($).then(() =>
                    $.prompt.submit({
                      text: `Re-read Karea task ${task.shortid}, then tell me in one line what changed.`,
                      asUser: true,
                    }),
                  )
                }
              />
              <Button key="later" label="Later" onPress={() => update($, remote, () => null)} />
            </Box>
            {changes.map(line => (
              <Text dimColor> · {line}</Text>
            ))}
          </Box>
        )}
        {list.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap">
            <Text color="warning">Karea {task.shortid} behind: </Text>
            <Text>{list.join(' · ')} </Text>
            <Button key="sync" label="Sync now" variant="primary" onPress={syncNow} />
            {armed ? (
              <Button key="clear" label="Clear anyway" onPress={() => void $.command.run({ command: 'clear' })} />
            ) : (
              <Button key="dismiss" label="Dismiss" onPress={() => update($, pending, () => [])} />
            )}
          </Box>
        )}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const task = await read($, active)
    if (!task) return <Text dimColor>No active Karea task. Run /ksync pick KA123.</Text>

    const now = await $.clock.now()
    const ages = await read($, contextAges)
    const timeline = await read($, events)
    const list = await read($, pending)
    // KA813: stale until rewritten after the session's first event, synced or not.
    const stale = staleSince(ages, timeline[0]?.at ?? 0)
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 12 - ages.length)

    return (
      <Box flexDirection="column">
        <Text bold>
          {task.shortid} {task.title}
        </Text>
        {task.status !== '' && <Text dimColor>{task.status}</Text>}
        <Text> </Text>
        <Text dimColor>CONTEXT</Text>
        {ages.length === 0 && <Text dimColor> No Context entries yet.</Text>}
        {ages.map(entry => {
          const filled = freshness(entry.updatedAt, now)
          const isStale = stale.has(entry.title)
          return (
            <Box flexDirection="row">
              <Text> {entry.title.padEnd(12).slice(0, 12)} </Text>
              <Text color={isStale ? 'warning' : 'success'}>{'█'.repeat(filled)}</Text>
              <Text dimColor>
                {'░'.repeat(10 - filled)} {ago(now - entry.updatedAt)}
              </Text>
              {isStale && <Text color="warning"> stale</Text>}
            </Box>
          )
        })}
        <Text> </Text>
        <Text dimColor>THIS SESSION</Text>
        {timeline.length === 0 && <Text dimColor> Nothing yet.</Text>}
        {timeline.slice(-room).map(event => (
          <Box flexDirection="row">
            <Text color={event.isSynced ? 'success' : 'warning'}> {event.isSynced ? '✓' : '•'} </Text>
            <Text>{event.label} </Text>
            <Text dimColor>{ago(now - event.at)}</Text>
          </Box>
        ))}
        <Text> </Text>
        <Box flexDirection="row" flexWrap="wrap">
          <Button
            key="pane-sync"
            label={list.length > 0 ? `Sync now (${list.length})` : 'Sync now'}
            variant="primary"
            onPress={() => void startSync($, task.shortid)}
          />
          <Button
            key="pane-review"
            label="Mark review"
            onPress={() => void $.command.run({ command: 'ksync', args: 'review' })}
          />
          {task.id !== '' && <Link href={taskUrl(api, task.id)} label="Open in Karea" />}
        </Box>
      </Box>
    )
  })
}
