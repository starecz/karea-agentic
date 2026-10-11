import type { ContextAge, HistoryRow, LocalEvent, Touched } from '../types'

export const AWAY_MS = 45 * 60 * 1000
export const MAX_PENDING = 8
export const MAX_EVENTS = 30
export const IDLE_POLL_MS = 30 * 60 * 1000

const SHORT_ID = /^[A-Za-z]{1,8}\d+$/

export function isShortId(ref: string): boolean {
  return SHORT_ID.test(ref.trim())
}

function org(command: string): string {
  const match = command.match(/(?:\s-o|--target-org)(?:=|\s+)("[^"]+"|'[^']+'|[^\s;&|]+)/)
  return match?.[1] ? match[1].replace(/^["']|["']$/g, '') : 'default org'
}

const GIT_OPTS = String.raw`(?:\s+(?:-C\s+\S+|-c\s+\S+|--?[\w-]+(?:=\S+)?))*`

type Rule = {
  pattern: RegExp
  label: string | ((command: string) => string)
  ok?: RegExp
  bad?: RegExp
}

const GIT_FAILED = /\[rejected\]|\bfatal:|\berror:|nothing to commit|Everything up-to-date/i

const GIT: Rule[] = [
  { pattern: new RegExp(String.raw`\bgit${GIT_OPTS}\s+commit\b`), label: 'committed', ok: /\[[^\]\n]+ [0-9a-f]{7,}\]/, bad: GIT_FAILED },
  { pattern: new RegExp(String.raw`\bgit${GIT_OPTS}\s+push\b`), label: 'pushed', ok: /\s->\s|\[new (branch|tag)\]/, bad: GIT_FAILED },
]

const GENERAL: Rule[] = [
  { pattern: /\bgh\s+pr\s+create\b/, label: 'opened a PR', ok: /https:\/\/\S+\/pull\/\d+/ },
  { pattern: /\bgh\s+pr\s+merge\b/, label: 'merged a PR', bad: /\b(failed|error)\b/i },
  { pattern: /\b(vercel|netlify)\b[^|;&]*\b(deploy|--prod)\b/, label: 'deployed', bad: /\b(error|failed)\b/i },
  { pattern: /\bfly\s+deploy\b/, label: 'deployed', bad: /\b(error|failed)\b/i },
  { pattern: /\bterraform\s+apply\b/, label: 'applied Terraform', ok: /Apply complete!/ },
  { pattern: /\b(prisma\s+migrate\s+(deploy|dev)|rails\s+db:migrate|alembic\s+upgrade|manage\.py\s+migrate)\b/, label: 'ran migrations', bad: /\b(error|failed)\b/i },
]

const SALESFORCE: Rule[] = [
  { pattern: /\bsf\s+project\s+deploy\s+(start|quick|resume)\b/, label: c => `deployed to ${org(c)}`, ok: /Status:\s*Succeeded|Deploy Succeeded/i, bad: /Status:\s*Failed|Component Failures|\bError\b/ },
  { pattern: /\bsf\s+data\s+(create|update|delete|upsert|import)\b/, label: c => `changed data in ${org(c)}`, bad: /\b(error|failed)\b/i },
]

export type Preset = 'git' | 'general' | 'salesforce' | 'both'

function rulesFor(preset: Preset): Rule[] {
  if (preset === 'git') return GIT
  if (preset === 'general') return [...GIT, ...GENERAL]
  if (preset === 'salesforce') return [...GIT, ...SALESFORCE]
  return [...GIT, ...GENERAL, ...SALESFORCE]
}

export function progressEvents(command: string, output: string, preset: Preset = 'git', extra = ''): string[] {
  const events: string[] = []
  for (const rule of [...rulesFor(preset), ...customRules(extra)]) {
    if (!rule.pattern.test(command)) continue
    if (rule.ok && !rule.ok.test(output)) continue
    if (rule.bad && rule.bad.test(output)) continue
    const text = typeof rule.label === 'string' ? rule.label : rule.label(command)
    if (!events.includes(text)) events.push(text)
  }
  return events
}

export function customRules(spec: string): Rule[] {
  const rules: Rule[] = []
  for (const part of spec.split(';')) {
    const [label, source] = part.split('=').map(item => item?.trim() ?? '')
    if (!label || !source) continue
    try {
      rules.push({ pattern: new RegExp(source), label })
    } catch {
      continue
    }
  }
  return rules
}

export const ANALYZE_SYSTEM = [
  'You read the LATEST exchange between a developer and a coding assistant working on a tracked task, and you fill in a JSON form about it. An EARLIER exchange and a list of OPEN DECISIONS (raised earlier in the conversation, not settled yet) may be given only as context: report nothing that was already settled there.',
  'decisions: choices made in this exchange. For each, madeBy is "developer" when the developer made it, asked for it or agreed to it, or "assistant" when it is only the assistant\'s proposal. kind is one of:',
  '"solution" (changes the architecture, design or approach of the solution),',
  '"scope" (changes what the task delivers or its acceptance criteria),',
  '"external" (based on what someone outside the session said, e.g. a coworker or the client said X so we do Y),',
  '"workaround" (an unusual or unorthodox way of doing something, chosen for a stated reason),',
  '"execution" (a go-ahead to run, deploy, test, retry or perform a step, or to continue: e.g. "ok, run those scripts"),',
  '"detail" (a small implementation or wording choice that does not change the outcome).',
  'why holds the stated reason, empty when none was given. settled is true only when the decision still stands at the end of the latest exchange: false when the assistant questioned it, pushed back, explained why it did otherwise, or asked the developer to confirm. A short reply like "yes" or "do it" settles a decision proposed or questioned earlier. When the latest exchange settles or drops one of the OPEN DECISIONS, report it with resolves set to that open decision\'s exact text, and settled true (decided) or false with kind "detail" (dropped). Leave out recaps of earlier decisions.',
  'questions: questions left unanswered at the end of the exchange. For each, answeredBy says who can answer it: "developer" (the developer can answer or decide it, including anything about the codebase, scripts, setup, environments, requirements defaults or what to do next), "assistant" (it can be found out by reading code, running something, checking an org or testing, even if nobody has done it yet), "external" (only a specific person or group outside this session can answer it: a client, a stakeholder, another team, a product owner), or "future" (see below). For "external", party names who, as written in the exchange; leave it empty when nobody is named.',
  '"future" is rare and strict: a "why does X happen" unknown that stayed UNRESOLVED AFTER REAL INVESTIGATION in this exchange (things were actually tried or checked and none explained it) AND is likely to come back later. For it, tried lists what was already tried, and recurs says why it will come back. It is never: something nobody has looked into yet, a todo or next step, a bug to fix, a missing tool, token or access, a requirement or default to decide, or a scope question.',
  'Reply with JSON only, each text under 14 words: {"decisions":[{"text":"...","madeBy":"developer","kind":"solution","why":"...","settled":true,"resolves":""}],"questions":[{"text":"...","answeredBy":"developer","party":"","tried":"","recurs":""}]}',
].join(' ')

export type Exchange = { prompt: string; answer: string }

export function analyzePrompt(prompt: string, answer: string, earlier?: Exchange, open: readonly { text: string }[] = []): string {
  const latest = `LATEST EXCHANGE\nDEVELOPER:\n${prompt.slice(0, 3000)}\n\nASSISTANT:\n${answer.slice(0, 8000)}`
  const parts: string[] = []
  if (open.length > 0) parts.push(`OPEN DECISIONS (context only)\n${open.map(item => `- ${item.text}`).join('\n')}`)
  if (earlier) {
    parts.push(`EARLIER EXCHANGE (context only)\nDEVELOPER:\n${earlier.prompt.slice(0, 1500)}\n\nASSISTANT:\n${earlier.answer.slice(0, 3000)}`)
  }
  return [...parts, latest].join('\n\n')
}

const OUTCOME_KINDS = new Set(['solution', 'scope', 'external', 'workaround'])
const ASSISTANT_OR_DEV = /\b(developer|dev|assistant|claude|ai|me|you|us|we|team member)\b/i

export function parseFindings(text: string, open: readonly { text: string }[] = []): string[] {
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (!json) return []
  try {
    const data = JSON.parse(json) as { decisions?: unknown; questions?: unknown }
    const items = (value: unknown) =>
      Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object') : []
    const textOf = (item: Record<string, unknown>) => (typeof item.text === 'string' ? item.text.trim() : '')
    const decisions = items(data.decisions)
      .filter(
        item =>
          item.madeBy === 'developer' &&
          item.settled === true &&
          (OUTCOME_KINDS.has(String(item.kind)) || open.some(o => o.text === item.resolves)) &&
          textOf(item) !== '',
      )
      .slice(0, 3)
      .map(item => `decision: ${clip(textOf(item), 60)}`)
    const filled = (value: unknown) => typeof value === 'string' && value.trim().length >= 8
    const questions = items(data.questions)
      .filter(item => {
        if (textOf(item) === '') return false
        if (item.answeredBy === 'future') return filled(item.tried) && filled(item.recurs)
        const party = typeof item.party === 'string' ? item.party.trim() : ''
        return item.answeredBy === 'external' && party !== '' && !ASSISTANT_OR_DEV.test(party)
      })
      .slice(0, 3)
      .map(item =>
        item.answeredBy === 'future'
          ? `open question for later: ${clip(textOf(item), 70)}`
          : `open question for ${clip(String(item.party), 24)}: ${clip(textOf(item), 50)}`,
      )
    return [...decisions, ...questions]
  } catch {
    return []
  }
}

export function addPending(pending: readonly string[], events: readonly string[]): string[] {
  const merged = [...pending.filter(item => !events.includes(item)), ...events]
  return merged.slice(-MAX_PENDING)
}

export function addEvents(list: readonly LocalEvent[], labels: readonly string[], at: number): LocalEvent[] {
  return [...list, ...labels.map(label => ({ at, label, isSynced: false }))].slice(-MAX_EVENTS)
}

export function markSynced(list: readonly LocalEvent[]): LocalEvent[] {
  return list.map(event => (event.isSynced ? event : { ...event, isSynced: true }))
}

const KAREA_TOOL = /karea/i
const WRITE_ACTION = /^karea_(create|edit|close|done|doing|quick|add|set|answer|link|unlink|delete|toggle|upload|update|mark|snooze|dismiss)/

export function kareaAction(tool: string, input: Record<string, unknown>): string | undefined {
  if (!KAREA_TOOL.test(tool)) return undefined
  if (typeof input.action === 'string') return input.action
  const legacy = tool.match(/__(karea_\w+)$/)
  return legacy?.[1]
}

export function isKareaWrite(tool: string, input: Record<string, unknown>): boolean {
  if (!KAREA_TOOL.test(tool)) return false
  if (/_write$/i.test(tool) || /__karea_delete$/i.test(tool) || /set_context$/i.test(tool)) return true
  const action = kareaAction(tool, input)
  return action !== undefined && WRITE_ACTION.test(action)
}

export function kareaParams(input: Record<string, unknown>): Record<string, unknown> {
  const params = input.params
  return params !== null && typeof params === 'object' ? (params as Record<string, unknown>) : input
}

export function taskRefOf(input: Record<string, unknown>): string | undefined {
  const params = kareaParams(input)
  for (const key of ['task', 'parent', 'taskId']) {
    const value = params[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

export function shortIdFromResult(text: string | undefined): string | undefined {
  return text?.match(/Short ID:\s*([A-Za-z]{1,8}\d+)/)?.[1]
}

const ACTION_LABELS: Record<string, string> = {
  karea_set_context: 'context',
  karea_set_markdown: 'document',
  karea_add_note: 'note',
  karea_edit_note: 'note edited',
  karea_edit_task: 'task',
  karea_edit_tasks: 'tasks',
  karea_close_task: 'closed',
  karea_done: 'closed',
  karea_create_task: 'created',
  karea_create_subtask: 'subtask',
  karea_doing: 'created, in progress',
  karea_quick_task: 'logged',
  karea_add_requisite: 'requisite',
  karea_toggle_requisite: 'requisite toggled',
  karea_link_session: 'session linked',
  karea_answer_question: 'question answered',
  karea_create_question: 'question',
}

function clip(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat
}

export function receipt(action: string, input: Record<string, unknown>): string {
  const params = kareaParams(input)
  const parts: string[] = []
  const label = ACTION_LABELS[action] ?? action.replace(/^karea_/, '').replace(/_/g, ' ')
  if (action === 'karea_set_context' && typeof params.title === 'string') {
    parts.push(`context ${params.title}`)
  } else if ((action === 'karea_add_note' || action === 'karea_edit_note') && typeof params.content === 'string') {
    parts.push(`note "${clip(params.content)}"`)
  } else {
    parts.push(label)
  }
  if (typeof params.status === 'string') parts.push(`status ${params.status}`)
  if (typeof params.note === 'string') parts.push(`note "${clip(params.note)}"`)
  if (typeof params.resolution === 'string') parts.push(`"${clip(params.resolution)}"`)
  return parts.join(' · ')
}

export function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export type ChipInput = {
  shortid: string
  pending: number
  remote: number
  lastSyncAt: number
  now: number
  title?: string
}

export type ChipTone = 'synced' | 'behind' | 'remote' | 'none'
export type ChipView = { tone: ChipTone; mark: string; label: string }

export const TITLE_CHARS = 25

export function shortTitle(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim()
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS).trimEnd()}…` : flat
}

export function chipView({ shortid, pending, remote, lastSyncAt, now, title = '' }: ChipInput): ChipView {
  if (shortid === '') return { tone: 'none', mark: '○', label: 'no Karea task · /ksync pick' }
  const name = title ? `${shortid} ${shortTitle(title)}` : shortid
  if (remote > 0) return { tone: 'remote', mark: '◆', label: `${name} · changed in Karea` }
  if (pending > 0) return { tone: 'behind', mark: '◐', label: `${name} · ${pending} unsynced` }
  if (lastSyncAt === 0) return { tone: 'synced', mark: '●', label: name }
  return { tone: 'synced', mark: '●', label: `${name} · synced ${ago(now - lastSyncAt)}` }
}

export function chip(input: ChipInput): string {
  const view = chipView(input)
  return `${view.mark} ${view.label}`
}

export const KAREA_GREEN = '#2BD4BD'

export const TONE_COLORS: Record<ChipTone, string> = {
  synced: KAREA_GREEN,
  behind: 'warning',
  remote: 'error',
  none: 'inactive',
}

const FIELD_LABELS: Record<string, string> = {
  slaDeadline: 'deadline',
  assignedToId: 'assignee',
  categoryId: 'category',
  customStatus: 'status',
  reviewStage: 'review stage',
  note_added: 'new note',
  note_edited: 'note edited',
  closedAt: 'closed',
}

const QUIET_FIELDS = new Set(['closedById', 'customStatus', 'mcpHintClickedAt', '_recap_generated', '_email_overdue'])

const PERSON_MODES = new Set(['user', 'ai'])

export function humanChanges(rows: readonly HistoryRow[], since: number): HistoryRow[] {
  return rows.filter(row => PERSON_MODES.has(row.mode) && Date.parse(row.createdAt) > since && !QUIET_FIELDS.has(row.field))
}

export function changeLine(row: HistoryRow): string {
  const field = FIELD_LABELS[row.field] ?? row.field.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  const next = row.newValue ? clip(row.newValue, 40) : ''
  const prev = row.oldValue ? clip(row.oldValue, 20) : ''
  if (row.field === 'note_added' || row.field === '_note') return `new note: "${next}"`
  if (prev && next) return `${field} ${prev} → ${next}`
  if (next) return `${field}: ${next}`
  return field
}

export function contextChanges(entries: readonly ContextAge[], since: number): string[] {
  return entries
    .filter(entry => PERSON_MODES.has(entry.lastEditedMode) && entry.updatedAt > since)
    .map(entry => `context "${entry.title}" edited`)
}

export function staleEntries(entries: readonly ContextAge[], lastLocalEventAt: number): Set<string> {
  return new Set(entries.filter(entry => entry.updatedAt < lastLocalEventAt).map(entry => entry.title))
}

export function freshness(updatedAt: number, now: number, width = 10): number {
  const hours = (now - updatedAt) / 3600000
  const filled = Math.round(width * Math.max(0, 1 - hours / 24))
  return Math.max(1, Math.min(width, filled))
}

export function syncRules(pending: readonly string[]): string {
  const questions = pending.filter(item => item.startsWith('open question for '))
  const rules: string[] = []
  if (pending.some(item => item.startsWith('decision: '))) {
    rules.push("Write each listed decision to the task's Decisions context entry with its reasoning.")
  }
  if (questions.length > 0) {
    rules.push(
      `For the listed open question${questions.length === 1 ? '' : 's'} (${questions.length}), ask me first (one AskUserQuestion) which to create as Karea open questions linked to the task; create only the ones I approve, and no others.`,
    )
  }
  rules.push(
    'Do NOT create any other Karea open questions: technical loose ends, investigation items, doubts and tooling wishes go in a "Loose ends" context entry instead. Zero new questions is the normal outcome.',
  )
  return rules.join(' ')
}

export function syncPrompt(shortid: string, pending: readonly string[]): string {
  const what = pending.length > 0 ? ` (${pending.join('; ')})` : ''
  return `Update Karea task ${shortid} with this session's progress since its last update${what}: refresh its context and add a note. ${syncRules(pending)} Then reply in one line.`
}

export function syncAllPrompt(tasks: readonly Touched[]): string {
  const list = tasks.map(task => `${task.shortid} (${task.pending.join('; ')})`).join('; ')
  return `Update each of these Karea tasks with this session's progress since its last update: ${list}. For each, refresh its context and add a note. ${syncRules(tasks.flatMap(task => task.pending))} Then reply with one line per task.`
}

export function rereadContext(shortid: string, reason: string): string {
  return `Active Karea task: ${shortid}. ${reason} Before acting on this message, re-read the task in Karea, as it may have changed: call karea_read with karea_view_task, then karea_get_context, karea_list_notes and karea_list_questions (task ${shortid}).`
}

export function pickContext(shortid: string, hasApi: boolean): string {
  return hasApi
    ? `The user made Karea task ${shortid} the active task for this session. Read its context before working on it.`
    : `The user made Karea task ${shortid} the active task for this session. Using the Karea tools: set it to in_progress if it is not already, link this session to it, and read its context before working on it.`
}

export function upsertTouched(list: readonly Touched[], entry: Touched): Touched[] {
  const rest = list.filter(item => item.shortid !== entry.shortid)
  return [...rest, entry].slice(-20)
}

export function recapText(list: readonly Touched[], activeShortid: string): string {
  if (list.length === 0) return 'No Karea tasks touched in this session yet.'
  const lines = list.map(task => {
    const mark = task.pending.length > 0 ? '◐' : '●'
    const state = task.pending.length > 0 ? `${task.pending.length} pending (${task.pending.join(', ')})` : 'synced'
    const active = task.shortid === activeShortid ? ' (active)' : ''
    return `  ${mark} ${task.shortid}${active} ${clip(task.title || '', 36)}  ${state}`
  })
  const behind = list.filter(task => task.pending.length > 0).length
  const tail = behind > 0 ? `\nRun /ksync sync all to sync ${behind} task${behind === 1 ? '' : 's'}.` : ''
  return `Karea tasks this session:\n${lines.join('\n')}${tail}`
}

export type KareaCommand =
  | { verb: 'pick'; ref: string }
  | { verb: 'status' | 'off' | 'pane' | 'recap' | 'review' | 'help' }
  | { verb: 'sync'; isAll: boolean }

export function parseCommand(args: string): KareaCommand {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const lower = verb.toLowerCase()
  if (lower === 'pick' && rest[0]) return { verb: 'pick', ref: rest[0] }
  if (isShortId(verb)) return { verb: 'pick', ref: verb }
  if (lower === 'sync') return { verb: 'sync', isAll: rest[0]?.toLowerCase() === 'all' }
  if (lower === '' || lower === 'status') return { verb: 'status' }
  if (lower === 'off' || lower === 'pane' || lower === 'recap' || lower === 'review') return { verb: lower }
  return { verb: 'help' }
}

export const HELP = [
  '/ksync pick KA123   make a task the active one (also: /ksync KA123)',
  '/ksync status       show the active task and what is not synced yet',
  '/ksync sync         ask Claude to write this session\'s progress to the task',
  '/ksync sync all     the same for every task touched in this session',
  '/ksync review       set the active task to review',
  '/ksync pane         open the task pane',
  '/ksync recap        list every task touched in this session',
  '/ksync off          stop tracking a task',
].join('\n')

export type ViewedTask = { id: string; shortid: string; title: string; status: string; notes: string[] }
export type ContextLine = { title: string; mode: string; stamp: string }
export type Snapshot = { status: string; notes: string[]; context: Record<string, string> }

export function mcpText(result: { content?: readonly { type: string; text?: string }[]; isError?: boolean }): string {
  return (result.content ?? []).map(block => block.text ?? '').join('\n')
}

export function parseViewTask(text: string): ViewedTask | undefined {
  const id = text.match(/^ID:\s*([0-9a-f-]{36})\s*$/m)?.[1]
  if (!id) return undefined
  const notes: string[] = []
  let inNotes = false
  for (const line of text.split('\n')) {
    if (/^Notes:\s*$/.test(line)) {
      inNotes = true
      continue
    }
    if (inNotes && /^\s{2}\S/.test(line)) notes.push(line.trim())
    else if (inNotes && line.trim() !== '' && !/^\s/.test(line)) inNotes = false
  }
  return {
    id,
    shortid: text.match(/^Short ID:\s*(\S+)\s*$/m)?.[1] ?? '',
    title: text.match(/^\*\*(.+)\*\*\s*$/m)?.[1] ?? '',
    status: (text.match(/^Status:\s*([a-z][a-z _]*?)\s*(?:\(|·|$)/m)?.[1] ?? '').replace(/ /g, '_'),
    notes,
  }
}

const CONTEXT_HEAD = /^## (.+?)\s+\[(\w+), updated (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/

export function parseContextText(text: string): ContextLine[] {
  const entries: ContextLine[] = []
  for (const line of text.split('\n')) {
    const match = line.match(CONTEXT_HEAD)
    if (match?.[1] && match[2] && match[3]) entries.push({ title: match[1], mode: match[2], stamp: match[3] })
  }
  return entries
}

export function contextAgesOf(entries: readonly ContextLine[]): ContextAge[] {
  return entries.map(entry => ({
    title: entry.title,
    updatedAt: Date.parse(`${entry.stamp.replace(' ', 'T')}Z`),
    lastEditedMode: entry.mode,
  }))
}

export function snapshotOf(task: ViewedTask, entries: readonly ContextLine[]): Snapshot {
  return {
    status: task.status,
    notes: task.notes,
    context: Object.fromEntries(entries.map(entry => [entry.title, `${entry.mode}|${entry.stamp}`])),
  }
}

function noteBody(note: string): string {
  return note.replace(/^\d{2} \w{3} \d{4}, \d{2}:\d{2} \([^)]*\):\s*/, '')
}

export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const lines: string[] = []
  if (before.status !== '' && after.status !== before.status) lines.push(`status ${before.status} → ${after.status}`)
  for (const note of after.notes.filter(note => !before.notes.includes(note))) {
    lines.push(`new note: "${clip(noteBody(note), 40)}"`)
  }
  for (const [title, value] of Object.entries(after.context)) {
    if (before.context[title] === value || !value.startsWith('user|')) continue
    lines.push(`context "${title}" edited`)
  }
  return lines
}

// karea_task_changes (KA748) answers for one task over the last 1 to 60 minutes.
export const CHANGES_MAX_MINUTES = 60

export type TaskChange = { at: number; stamp: string; text: string; by: string; mode: string }

// Minutes to ask for: the time since the last check, plus one for clock drift. Undefined when the gap is
// longer than the server can answer for, so the caller re-reads the task instead.
export function changesWindow(lastCheckAt: number, now: number): number | undefined {
  if (lastCheckAt <= 0) return undefined
  const minutes = Math.ceil((now - lastCheckAt) / 60000)
  if (minutes > CHANGES_MAX_MINUTES) return undefined
  return Math.min(CHANGES_MAX_MINUTES, Math.max(1, minutes + 1))
}

// A server from before karea_task_changes refuses the action by name.
export function isUnknownAction(text: string | undefined): boolean {
  return /Unknown action|is not a Karea action|is an action of /.test(text ?? '')
}

const CHANGE_ROW = /^- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.+) · by (.+) \(([\w-]+)\)\s*$/

// Rows look like "- 2026-10-07T11:17:53Z status: open -> blocked · by Alex (user)", newest first.
export function parseTaskChanges(text: string): TaskChange[] {
  const rows: TaskChange[] = []
  for (const line of text.split('\n')) {
    const match = line.match(CHANGE_ROW)
    if (!match?.[1] || !match[2] || !match[3] || !match[4]) continue
    rows.push({ at: Date.parse(match[1]), stamp: match[1], text: match[2], by: match[3], mode: match[4] })
  }
  return rows
}

export function changeKey(row: TaskChange): string {
  return `${row.stamp} ${row.text} ${row.by} ${row.mode}`
}

const QUIET_LABELS = new Set(['closed by', 'custom status', 'mcp hint clicked at', 'recap generated', 'email overdue'])

// Only what a person changed, in the browser (user) or through Karea AI (ai). The session's own writes come
// back as mcp and are left out, like Jira and system rows.
export function personChanges(rows: readonly TaskChange[], since: number, seen: readonly string[]): TaskChange[] {
  return rows
    .filter(row => PERSON_MODES.has(row.mode) && row.at > since && !seen.includes(changeKey(row)))
    .filter(row => !QUIET_LABELS.has(row.text.split(':')[0]?.trim().toLowerCase() ?? ''))
    .sort((a, b) => a.at - b.at)
}

export function taskChangeLine(row: TaskChange): string {
  const note = row.text.match(/^Note (added|edited): "(.*)"$/)
  if (note) return `${note[1] === 'added' ? 'new note' : 'note edited'}: "${clip(note[2] ?? '', 40)}" (${row.by})`
  const entry = row.text.match(/^Context entry (created|edited): "(.*)"$/)
  if (entry) return `context "${entry[2] ?? ''}" ${entry[1] === 'created' ? 'added' : 'edited'} (${row.by})`
  const field = row.text.match(/^([^:]+): (.+?) -> (.+)$/)
  if (field) return `${field[1]} ${clip(field[2] ?? '', 20)} → ${clip(field[3] ?? '', 40)} (${row.by})`
  return `${clip(row.text, 60)} (${row.by})`
}

// The status the newest status row moved the task to, if any.
export function statusFromChanges(rows: readonly TaskChange[]): string | undefined {
  const newest = [...rows].sort((a, b) => b.at - a.at).find(row => /^status: /.test(row.text))
  return newest?.text.match(/-> ([a-z_]+)$/)?.[1]
}

// KA759: Karea refuses to close a task with open subtasks until it is told what to do with them.
export type SubtaskRefusal = { title: string; count: number; subtasks: string[] }

export function subtaskRefusal(text: string | undefined): SubtaskRefusal | undefined {
  const match = text?.match(/Cannot close "(.+?)" yet: it has (\d+) open subtasks?:\n((?:[ \t]+.*\n?)*)/)
  if (!match?.[1] || !match[2]) return undefined
  const subtasks = (match[3] ?? '')
    .split('\n')
    .map(line => line.trim().replace(/^- /, ''))
    .filter(line => line !== '' && !line.startsWith('...'))
  return { title: match[1], count: Number(match[2]), subtasks }
}

export const CLOSE_ALL = 'Close them all'
export const CLOSE_ONLY = 'Close only this task'
export const KEEP_OPEN = 'Keep it open'

export function subtaskAsk(refusal: SubtaskRefusal): string {
  const shown = refusal.subtasks.slice(0, 4).join('; ')
  const more = refusal.count > 4 ? ` and ${refusal.count - 4} more` : ''
  const them = refusal.count === 1 ? 'it' : 'them'
  return `Karea did not close "${clip(refusal.title, 50)}": it has ${refusal.count} open subtask${refusal.count === 1 ? '' : 's'} (${shown}${more}). Close ${them} too?`
}

export function subtaskAnswerContext(answer: string | undefined, action: string, tool: string): string {
  const call = `${tool} with action ${action} again, with the same params plus`
  if (answer === CLOSE_ALL) return `Karea refused the close because of open subtasks. The user chose to close them all: call ${call} closeSubtasks: true.`
  if (answer === CLOSE_ONLY) return `Karea refused the close because of open subtasks. The user chose to close only this task: call ${call} closeSubtasks: false.`
  if (answer === KEEP_OPEN) return 'Karea refused the close because of open subtasks, and the user chose to keep the task open. Do not close it; carry on with the rest of the sync.'
  return `Karea refused the close because of open subtasks. Ask the user (one AskUserQuestion) whether to close them all or only this task, then call ${call} closeSubtasks true or false to match the answer.`
}

export const OPEN_DECISION_TURNS = 40
export type OpenDecision = { text: string; age: number }

// Decisions raised by the developer but not settled yet, so a "yes, go" many messages later still counts.
export function trackOpenDecisions(open: readonly OpenDecision[], reply: string): OpenDecision[] {
  const json = reply.match(/\{[\s\S]*\}/)?.[0]
  let data: { decisions?: unknown } = {}
  try {
    data = json ? (JSON.parse(json) as { decisions?: unknown }) : {}
  } catch {
    data = {}
  }
  const decisions = Array.isArray(data.decisions)
    ? data.decisions.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    : []
  const settledTexts = decisions
    .filter(item => item.settled === true && typeof item.text === 'string')
    .map(item => String(item.text).toLowerCase())
  const resolves = (open: OpenDecision) =>
    decisions.some(item => item.resolves === open.text) || settledTexts.includes(open.text.toLowerCase())
  const fresh = decisions
    .filter(
      item =>
        item.madeBy === 'developer' &&
        item.settled === false &&
        OUTCOME_KINDS.has(String(item.kind)) &&
        typeof item.text === 'string' &&
        item.text.trim() !== '',
    )
    .map(item => ({ text: clip(String(item.text), 80), age: 0 }))
  const kept = open
    .filter(item => !resolves(item))
    .map(item => ({ ...item, age: item.age + 1 }))
    .filter(item => item.age <= OPEN_DECISION_TURNS)
  const merged = [...kept.filter(item => !fresh.some(f => f.text === item.text)), ...fresh]
  return merged.slice(-5)
}

export type Meeting = { id: string; startAt: number; title: string; project: string }

// karea_list_meetings text: "- 2026-10-08 13:00 - Title [Project] (id: <uuid>)"; times are the user's local time.
export function parseMeetings(text: string): Meeting[] {
  const meetings: Meeting[] = []
  for (const line of text.split('\n')) {
    const match = line.match(/^- (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) - (.+?) \(id: ([0-9a-f-]{36})\)\s*$/)
    if (!match) continue
    const [, y, mo, d, h, mi, rest = '', id = ''] = match
    const project = rest.match(/\[([^\]]+)\]\s*$/)?.[1] ?? ''
    const title = rest.replace(/\s*\[[^\]]+\]\s*$/, '').trim()
    meetings.push({ id, startAt: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime(), title, project })
  }
  return meetings.sort((a, b) => a.startAt - b.startAt)
}

// The next occurrence that has not started yet of the meeting the user named; same project first.
export function pickMeeting(meetings: readonly Meeting[], name: string, project: string, now: number): Meeting | undefined {
  const wanted = name.trim().toLowerCase()
  if (wanted === '') return undefined
  const upcoming = meetings.filter(m => m.startAt > now && m.title.toLowerCase().includes(wanted))
  const sameProject = upcoming.filter(m => project !== '' && m.project.toLowerCase() === project.trim().toLowerCase())
  return sameProject[0] ?? upcoming[0]
}

export function meetingLabel(meeting: Meeting): string {
  const at = new Date(meeting.startAt)
  const day = at.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return `${clip(meeting.title, 40)} (${day} ${time})`
}

export function questionIds(text: string | undefined): { id: string; shortid: string } | undefined {
  const id = text?.match(/^ID:\s*([0-9a-f-]{36})\s*$/m)?.[1]
  if (!id) return undefined
  return { id, shortid: text?.match(/^Short ID:\s*(\S+)\s*$/m)?.[1] ?? 'question' }
}

export const NO_MEETING = 'No meeting, task only'
export const ASK_MEETING = "I'm about to create this open question. Link it to a meeting, or keep it attached only to the task?"

export function linkInstruction(shortid: string, questionId: string, meetingId: string, label: string): string {
  return `Open question ${shortid} must be linked to the meeting ${label}: call karea_link_question_to_meeting with meetingId ${meetingId} and questionId ${questionId} now, then mention it in one short line.`
}
