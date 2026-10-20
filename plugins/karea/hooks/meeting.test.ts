import { expect, mock, test } from 'claude-code/testing'

import { parseMeetings, pickMeeting } from './rules'

const LIST = [
  'Meetings (6):',
  '- 2026-10-08 12:00 - ACME : Portal Refinement Call [Acme] (id: aaaaaaaa-0000-4000-8000-000000000001)',
  '- 2026-10-08 13:00 - ACME : Portal Daily Scrum/ Demo session [Acme] (id: aaaaaaaa-0000-4000-8000-000000000002)',
  '- 2026-10-09 12:15 - Dentist @ City Clinic (id: aaaaaaaa-0000-4000-8000-000000000003)',
  '- 2026-10-09 13:00 - ACME : Portal Daily Scrum/ Demo session [Acme] (id: aaaaaaaa-0000-4000-8000-000000000004)',
  '- 2026-10-12 13:00 - ACME : Portal Daily Scrum/ Demo session [Acme] (id: aaaaaaaa-0000-4000-8000-000000000005)',
  '- 2026-10-09 13:00 - Team Daily [Internal] (id: aaaaaaaa-0000-4000-8000-000000000006)',
].join('\n')

const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()

test('reads Karea meeting lines', async () => {
  const meetings = parseMeetings(LIST)
  expect(meetings).toHaveLength(6)
  expect(meetings[0]).toEqual({
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    startAt: Date.UTC(2026, 9, 8, 12, 0),
    title: 'ACME : Portal Refinement Call',
    project: 'Acme',
  })
  expect(meetings.find(m => m.title.startsWith('Dentist'))?.project).toBe('')
  expect(parseMeetings('- 2026-10-20 11:00 - JJJQ : Daily [JnJ] (id: aaaaaaaa-0000-4000-8000-000000000009) - 1 open question(s)')).toHaveLength(1)
})

test('links to the earliest occurrence of the named meeting not yet ended, in the question project only', async () => {
  const meetings = parseMeetings(LIST)
  const daily = 'Daily Scrum'
  expect(pickMeeting(meetings, daily, 'Acme')?.id).toBe('aaaaaaaa-0000-4000-8000-000000000002')
  expect(pickMeeting(meetings.filter(m => m.id !== 'aaaaaaaa-0000-4000-8000-000000000002'), daily, 'Acme')?.id).toBe('aaaaaaaa-0000-4000-8000-000000000004')
  expect(pickMeeting(meetings, 'daily', 'Internal')?.id).toBe('aaaaaaaa-0000-4000-8000-000000000006')
  expect(pickMeeting(meetings, daily, 'Harrier')).toBe(undefined)
  expect(pickMeeting(meetings, daily, '')?.id).toBe('aaaaaaaa-0000-4000-8000-000000000002')
  expect(pickMeeting(meetings, '', 'Acme')).toBe(undefined)
  expect(pickMeeting(meetings, 'standup', 'Acme')).toBe(undefined)
})

function server(links: { meetingId: string; questionId: string }[]) {
  return ($: unknown, e: unknown) => {
    const { tool, args } = e as { tool: string; args: { action: string; params: Record<string, string> } }
    if (args.action === 'karea_list_meetings') return { value: { content: [{ type: 'text', text: LIST }], isError: false } } as never
    if (tool === 'karea_meetings_write' && args.action === 'karea_link_question_to_meeting') {
      links.push({ meetingId: args.params.meetingId ?? '', questionId: args.params.questionId ?? '' })
      return { value: { content: [{ type: 'text', text: 'Linked.' }], isError: false } } as never
    }
    return { value: { content: [{ type: 'text', text: '' }], isError: false } } as never
  }
}

const CREATED = 'Question created: "Will UAT be refreshed?"\nShort ID: ACQ40\nID: 0f0e0d0c-1111-2222-3333-444455556666\nLink: https://karea.app/dashboard/questions'
const CREATE = {
  tool: 'mcp__karea__karea_meetings_write',
  action: 'karea_create_question',
  params: { question: 'Will UAT be refreshed?', projectId: 'Acme', taskIds: ['AC22'] },
}

test('with a meeting set, a new question is linked to its earliest occurrence not ended, and Claude hears of it', { options: { questionMeeting: 'Daily Scrum' } }, async ($, on) => {
  mock.clock(on, { now: at(8, 13, 5) })
  const links: { meetingId: string; questionId: string }[] = []
  on('mcp.call', server(links))
  on('tool.call', () => ({ result: '', text: CREATED }) as never)
  const ran = (await $.tool.call(CREATE as never)) as { context?: string[] }
  expect(links).toEqual([{ meetingId: 'aaaaaaaa-0000-4000-8000-000000000002', questionId: '0f0e0d0c-1111-2222-3333-444455556666' }])
  expect(ran.context?.join(' ')).toContain('was linked to the meeting')
})

test('a typed answer to the meeting question is passed on to Claude, nothing linked (KA991)', async ($, on) => {
  mock.clock(on, { now: at(8, 9) })
  const links: { meetingId: string; questionId: string }[] = []
  on('mcp.call', server(links))
  on('tool.call', ($, e) => {
    if ((e as unknown as { tool: string }).tool === 'AskUserQuestion') {
      const input = e as unknown as { questions: { question: string }[] }
      return { result: { answers: { [input.questions[0]?.question ?? '']: "link it to today's daily" } }, text: '' } as never
    }
    return { result: '', text: CREATED } as never
  })
  const ran = (await $.tool.call(CREATE as never)) as { context?: string[] }
  expect(links).toEqual([])
  expect(ran.context?.join(' ')).toContain(`with: "link it to today's daily"`)
})

test("with 'none', nothing is linked and nobody is asked", { options: { questionMeeting: 'none' } }, async ($, on) => {
  mock.clock(on, { now: at(8, 9) })
  const links: { meetingId: string; questionId: string }[] = []
  on('mcp.call', server(links))
  on('tool.call', () => ({ result: '', text: CREATED }) as never)
  await $.tool.call(CREATE as never)
  expect(links).toEqual([])
})

test('with no setting, the user is asked and the chosen meeting is linked', async ($, on) => {
  mock.clock(on, { now: at(8, 9) })
  const links: { meetingId: string; questionId: string }[] = []
  let asked = ''
  let offered: string[] = []
  on('mcp.call', server(links))
  on('tool.call', ($, e) => {
    if ((e as unknown as { tool: string }).tool === 'AskUserQuestion') {
      const input = e as unknown as { questions: { question: string; options: { label: string }[] }[] }
      asked = input.questions[0]?.question ?? ''
      offered = input.questions[0]?.options.map(o => o.label) ?? []
      return { result: { answers: { [asked]: offered[1] } }, text: '' } as never
    }
    return { result: '', text: CREATED } as never
  })
  await $.tool.call(CREATE as never)
  expect(asked).toBe("I'm about to create this open question. Link it to a meeting, or keep it attached only to the task?")
  expect(offered[offered.length - 1]).toBe('No meeting, task only')
  expect(links).toEqual([{ meetingId: 'aaaaaaaa-0000-4000-8000-000000000002', questionId: '0f0e0d0c-1111-2222-3333-444455556666' }])
})

test('if the mod cannot link the question itself, Claude is told exactly how to link it', { options: { questionMeeting: 'Daily Scrum' } }, async ($, on) => {
  mock.clock(on, { now: at(8, 13, 5) })
  on('mcp.call', ($, e) => {
    const { args } = e as unknown as { args: { action: string } }
    if (args.action === 'karea_list_meetings') return { value: { content: [{ type: 'text', text: LIST }], isError: false } } as never
    return { value: { content: [{ type: 'text', text: 'Permission denied by auto mode' }], isError: true } } as never
  })
  on('tool.call', () => ({ result: '', text: CREATED }) as never)
  const ran = (await $.tool.call(CREATE as never)) as { context?: string[] }
  expect(ran.context?.join(' ')).toContain('call karea_link_question_to_meeting with meetingId aaaaaaaa-0000-4000-8000-000000000002 and questionId 0f0e0d0c-1111-2222-3333-444455556666')
})
