import { expect, test } from 'claude-code/testing'

// KA1210: the system prompt tells the model to link every Karea item it names.
test('adds the Karea links section once, on the configured URL', { options: { baseUrl: 'https://karea.example/' } }, async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }) as never)
  const { sections } = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
  const mine = sections.filter((s) => s.id === 'karea:links')
  expect(mine.length).toBe(1)
  expect(mine[0].text.includes('https://karea.example/dashboard/task/<task UUID>')).toBe(true)
  expect(mine[0].text.includes('https://karea.app')).toBe(false)
  expect(sections[sections.length - 1].id).toBe('karea:links')
})
