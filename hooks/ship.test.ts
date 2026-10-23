import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEMO } from './steps'

const SHIP = '\u{1F6A2}'
const SYNC = '\u{1F504}'
const MERGE = '\u{1F500}'
const BUILD = '\u{1F528}'
const STAGE = '\u{1F4CB}'
const COMMIT = '\u{1F4DD}'
const PUSH = '\u{1F680}'
const CLEAN = '\u{1F9F9}'
const HAND = '\u{270B}'
const CROSS = '\u{274C}'
const CHECK = '\u{2705}'
const BOLT = '\u{26A1}'

const BASE = 'Add CSV export'

type Options = {
  /** False plays a session with no desktop-app tools (a plain terminal). */
  hasDesktop?: boolean
  /** What the mod's store already holds, as after a reload or a resume. */
  store?: Record<string, unknown>
}

/** The test's stand-in for the desktop app and the engine beneath the mod. */
function world(on: On, options: Options = {}) {
  const clock = mock.clock(on)
  mock.store(on, options.store)

  const w = {
    title: BASE,
    titles: [] as string[],
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    logs: [] as string[],
    tools: [] as string[],
    nextTool: { isError: false, text: '' },
    settle: () => clock.settle(),
    advance: (ms: number) => clock.advance(ms),
  }

  on('session.id', () => ({ value: 'test-session' }))
  on('command.register', () => ({ value: { command: 'ship-status' } }))
  on('mcp.call', (_, e) => {
    if (options.hasDesktop === false || e.server !== 'ccd_session_mgmt') return { deny: 'no such server' }
    if (e.tool === 'get_session') {
      return { value: { content: [{ type: 'text', text: JSON.stringify({ title: w.title }) }], isError: false } }
    }
    w.title = String(e.args.title)
    w.titles.push(w.title)
    return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } }
  })
  on('ui.status', (_, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', (_, e) => {
    w.tools.push(e.tool)
    const { isError, text } = w.nextTool
    w.nextTool = { isError: false, text: '' }
    return isError ? { isError: true as const, result: text, text } : { result: {}, text }
  })

  return w
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
const ship = ($: Engine) => $.skill.prompt({ skill: 'ship-it', text: 'the steps' })
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const endTurn = ($: Engine) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
const startTurn = ($: Engine) => $.turn.start({ text: 'yes', turnId: 't2' })
const typed = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const slash = ($: Engine, args: string) =>
  $.command.run({ command: 'ship-status', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

test('the first ship-it puts an icon on the title without asking, and it follows all seven steps', async ($, on) => {
  const w = world(on)
  await start($)

  await ship($)
  await w.settle()
  expect(w.titles.at(-1)).toBe(`${SHIP} ${BASE}`)
  expect(w.statuses.at(-1)).toBe(`${SHIP} ship-it Starting`)

  const steps: [string, string][] = [
    ['git fetch && git pull', SYNC],
    ['git merge origin/master', MERGE],
    ['dotnet build', BUILD],
    ['git status', STAGE],
    ['git add Site/Views/Home/Index.cshtml', STAGE],
    ['git commit -m "Application => Area => Description"', COMMIT],
    ['git fetch origin master', PUSH],
    ['git push origin claude/brisk-otter-1a2b:master', PUSH],
    ['git push origin --delete claude/brisk-otter-1a2b', CHECK],
  ]
  for (const [command, icon] of steps) {
    await bash($, command)
    await w.settle()
    expect(w.titles.at(-1), command).toBe(`${icon} ${BASE}`)
  }
  expect(w.titles).toContain(`${CLEAN} ${BASE}`)
  expect(w.tools.includes('AskUserQuestion')).toBe(false)
})

test('it waits for the person at a confirmation and picks up again when they answer', async ($, on) => {
  const w = world(on)
  await start($)
  await ship($)
  await bash($, 'git add a.cs')
  await endTurn($)
  await w.settle()
  expect(w.titles.at(-1)).toBe(`${HAND}${STAGE} ${BASE}`)
  expect(w.statuses.at(-1)).toBe(`${HAND}${STAGE} ship-it 4/7 Stage: waiting for you`)

  await startTurn($)
  await w.settle()
  expect(w.titles.at(-1)).toBe(`${STAGE} ${BASE}`)
})

test('other skills and ordinary commands are left alone', async ($, on) => {
  const w = world(on)
  await start($)
  await $.skill.prompt({ skill: 'commit', text: 'x' })
  await bash($, 'git fetch')
  await w.settle()
  expect(w.titles).toEqual([])
  expect(w.statuses).toEqual([])
})

test('a failed build shows a cross and a toast', async ($, on) => {
  const w = world(on)
  await start($)
  await ship($)
  w.nextTool = { isError: true, text: 'Program.cs(12,5): error CS1002: ; expected\nBuild FAILED.' }
  await bash($, 'dotnet build')
  await w.settle()
  expect(w.titles.at(-1)).toBe(`${CROSS}${BUILD} ${BASE}`)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('failed')

  await endTurn($) // the model reports; the cross stays
  await w.settle()
  expect(w.titles.at(-1)).toBe(`${CROSS}${BUILD} ${BASE}`)
  expect(w.toasts).toHaveLength(1)
})

test('finishing the push ends in a check mark; the next prompt clears the status line and makes it a bolt', async ($, on) => {
  const w = world(on)
  await start($)
  await ship($)
  await bash($, 'git commit -m x')
  await bash($, 'git push origin x:master')
  await endTurn($) // step 7 never ran: the branch is not a claude/* branch
  await w.settle()
  expect(w.titles.at(-1)).toBe(`${CHECK} ${BASE}`)
  expect(w.statuses.at(-1)).toBe(`${CHECK} ship-it: shipped`)

  await typed($, 'thanks')
  await w.settle()
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.titles.at(-1)).toBe(`${BOLT} ${BASE}`)
})

test('the next prompt after a ship says new work with a bolt; the ship-it turn itself does not', async ($, on) => {
  const w = world(on)
  await start($)
  await ship($)
  await startTurn($) // the turn that runs ship-it: a run is under way, so this is not new work
  await w.settle()
  expect(w.title).toBe(`${SHIP} ${BASE}`)

  await bash($, 'git commit -m x')
  await bash($, 'git push origin x:master')
  await endTurn($)
  await w.settle()
  expect(w.title).toBe(`${CHECK} ${BASE}`)

  await typed($, 'now add a delete button')
  await startTurn($)
  await w.settle()
  expect(w.title).toBe(`${BOLT} ${BASE}`)
  expect(w.statuses.at(-1)).toBeUndefined()

  await bash($, 'git status') // nothing is being shipped now: the bolt stays
  await w.settle()
  expect(w.title).toBe(`${BOLT} ${BASE}`)
})

test('a turn that starts after a ship is new work even with no typed prompt, as a skill command makes', async ($, on) => {
  const w = world(on)
  await start($)
  await ship($)
  await bash($, 'git push origin x:master')
  await endTurn($)
  await w.settle()
  expect(w.title).toBe(`${CHECK} ${BASE}`)

  await startTurn($)
  await w.settle()
  expect(w.title).toBe(`${BOLT} ${BASE}`)
})

test('a slash command, or a prompt the person did not type, is not new work', async ($, on) => {
  const w = world(on)
  await start($)
  await ship($)
  await bash($, 'git push origin x:master')
  await endTurn($)
  await w.settle()
  expect(w.title).toBe(`${CHECK} ${BASE}`)

  await slash($, '') // a local command starts no turn
  await $.prompt.submit({ text: '/model', command: { name: 'model', args: '' }, wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'the background task finished', isMeta: true, wait: false, origin: { kind: 'task-notification' } })
  await w.settle()
  expect(w.title).toBe(`${CHECK} ${BASE}`)
})

test('ship-it again after new work starts over from the plain title', async ($, on) => {
  const w = world(on)
  await start($)
  await ship($)
  await bash($, 'git push origin x:master')
  await endTurn($)
  await typed($, 'one more thing')
  await w.settle()
  expect(w.title).toBe(`${BOLT} ${BASE}`)

  await ship($)
  await w.settle()
  expect(w.title).toBe(`${SHIP} ${BASE}`)
})

test('a session without the desktop tools gets the status line only, and says so', async ($, on) => {
  const w = world(on, { hasDesktop: false })
  await start($)
  await ship($)
  await bash($, 'git fetch')
  await w.settle()
  expect(w.titles).toEqual([])
  expect(w.statuses.at(-1)).toBe(`${SYNC} ship-it 1/7 Sync`)
  expect(w.logs.some(line => line.includes('cannot reach'))).toBe(true)
})

test('a rename made by hand between two runs is kept', async ($, on) => {
  const w = world(on)
  await start($)
  await ship($)
  await bash($, 'git commit -m x')
  await bash($, 'git push origin x:master')
  await endTurn($)
  await w.settle()
  expect(w.title).toBe(`${CHECK} ${BASE}`)

  w.title = 'CSV export v2' // the person renames the session themselves
  await ship($)
  await w.settle()
  expect(w.title).toBe(`${SHIP} CSV export v2`)

  await slash($, 'off')
  await w.settle()
  expect(w.title).toBe('CSV export v2')
})

test('a second run starts over from the live title, not from a stale icon', async ($, on) => {
  const w = world(on)
  await start($)
  await ship($)
  await bash($, 'git fetch')
  await w.settle()
  expect(w.title).toBe(`${SYNC} ${BASE}`)

  await ship($) // the title still carries the sync icon from before
  await w.settle()
  expect(w.title).toBe(`${SHIP} ${BASE}`)
})

test('/ship-status reports, sets a step by hand, and turns off and on', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await slash($, '')).text).toContain('not started yet')

  await ship($)
  await w.settle()
  expect((await slash($, '')).text).toContain('a status icon')

  const set = await slash($, 'step 5')
  expect(set.text).toBe(`${COMMIT} ship-it 5/7 Commit`)
  await w.settle()
  expect(w.title).toBe(`${COMMIT} ${BASE}`)

  const off = await slash($, 'off')
  expect(off.text).toContain('original title is back')
  await w.settle()
  expect(w.title).toBe(BASE)
  expect(w.statuses.at(-1)).toBeUndefined()
  expect((await slash($, '')).text).toContain('off')

  const written = w.titles.length
  await ship($)
  await bash($, 'git fetch')
  await w.settle()
  expect(w.titles).toHaveLength(written) // off: ship-it leaves the title alone
  expect((await slash($, 'step 3')).text).toContain('run /ship-status on first')

  await slash($, 'on')
  await ship($)
  await w.settle()
  expect(w.title).toBe(`${SHIP} ${BASE}`)
})

test('/ship-status step idle clears a stuck mark', async ($, on) => {
  const w = world(on)
  await start($)
  await slash($, 'step 4')
  await w.settle()
  expect(w.title).toBe(`${STAGE} ${BASE}`)

  expect((await slash($, 'step idle')).text).toBe('Cleared.')
  await w.settle()
  expect(w.title).toBe(BASE)
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('/ship-status step work shows the bolt and pins nothing under the prompt', async ($, on) => {
  const w = world(on)
  await start($)
  const set = await slash($, 'step work')
  expect(set.text).toBe(`${BOLT} new work since the last ship-it`)
  await w.settle()
  expect(w.title).toBe(`${BOLT} ${BASE}`)
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('/ship-status demo shows every moment, then puts the title back', async ($, on) => {
  const w = world(on)
  await start($)
  const started = await slash($, 'demo')
  expect(started.text).toContain(`${DEMO.length} moments`)
  await w.settle()
  for (let i = 0; i < DEMO.length; i++) await w.advance(1500)
  await w.settle()

  for (const icon of [SHIP, SYNC, MERGE, BUILD, STAGE, COMMIT, PUSH, CLEAN, CHECK, BOLT, HAND, CROSS]) {
    expect(w.titles.some(title => title.includes(icon)), icon).toBe(true)
  }
  expect(w.titles.at(-1)).toBe(BASE)
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('it carries on from what was saved when the mod reloads mid-run', async ($, on) => {
  // The store holds a run that was waiting at the build, and the base title saved with it.
  const w = world(on, {
    store: {
      'cfg:test-session': { isOn: true, base: BASE },
      'run:test-session': { active: true, step: 3, strong: 3, phase: 'waiting', pushed: false },
    },
  })
  await start($)
  await w.settle()
  expect(w.titles.at(-1)).toBe(`${HAND}${BUILD} ${BASE}`)

  await startTurn($)
  await bash($, 'git add a.cs')
  await w.settle()
  expect(w.titles.at(-1)).toBe(`${STAGE} ${BASE}`)
})

test('a saved off is still off in the next ship-it', async ($, on) => {
  const w = world(on, { store: { 'cfg:test-session': { isOn: false, base: BASE } } })
  await start($)
  await ship($)
  await bash($, 'git fetch')
  await w.settle()
  expect(w.titles).toEqual([])
  expect(w.statuses).toEqual([])
})

test('a tool call with no command is passed straight on', async ($, on) => {
  const w = world(on)
  await start($)
  await ship($)
  await w.settle()
  const before = w.titles.length
  await $.tool.call({ tool: 'Bash', command: undefined as unknown as string })
  await w.settle()
  expect(w.titles).toHaveLength(before)
})
