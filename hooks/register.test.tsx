import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'desktop-hud',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const PLAN = 'mcp__ccd_turn__update_plan'

// Each hook here stands for the engine beneath the mod.
function engine(on: On) {
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/work/my-project' }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

test('the desktop band shows the model, tool counts and the current plan step', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'Read', file_path: '/work/my-project/a.ts' })
  await $.tool.call({ tool: 'Read', file_path: '/work/my-project/b.ts' })
  await $.tool.call({
    tool: PLAN,
    items: [
      { content: 'Read the code', status: 'completed' },
      { content: 'Write the fix', status: 'in_progress' },
      { content: 'Run the tests', status: 'pending' },
    ],
  })

  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /\[Opus 5\.5\]/ }))?.text).toBe('[Opus 5.5]')
  expect((await ui.find({ type: 'Text', text: /^my-project$/ }))?.text).toBe('my-project')
  expect((await ui.find({ type: 'Text', text: /×2/ }))?.text).toBe(' ×2')
  expect((await ui.find({ type: 'Text', text: /Write the fix/ }))?.text).toBe('Write the fix')
  expect((await ui.find({ type: 'Text', text: /\(1\/3\)/ }))?.text).toBe(' (1/3)')
  await ui.unmount()

  await $.tool.call({ tool: PLAN, advance: true })
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Run the tests/ }))?.text).toBe('Run the tests')
  expect((await ui.find({ type: 'Text', text: /\(2\/3\)/ }))?.text).toBe(' (2/3)')
  await ui.unmount()
})

test('TodoWrite and TaskCreate/TaskUpdate feed the same todo row', async ($, on) => {
  engine(on)
  on('tool.call', (_, e) => ({ result: e.tool === 'TaskCreate' ? { task: { id: '7', subject: 'Ship it' } } : {} }))

  await $.tool.call({ tool: 'TaskCreate', subject: 'Ship it', description: 'ship' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'in_progress' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Ship it/ }))?.text).toBe('Ship it')
  expect((await ui.find({ type: 'Text', text: /\(0\/1\)/ }))?.text).toBe(' (0/1)')
  await ui.unmount()
})

test('the terminal keeps what is beneath: claude-hud draws there', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  expect(await ui.find({ type: 'Text', text: /Context/ })).toBeUndefined()
  await ui.unmount()
})
