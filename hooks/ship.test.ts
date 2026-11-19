import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

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
// A prompt with enough in it to be asked about, and the title the small model gives it.
const LONG = 'Now a different thing: the invoice PDF splits its totals across two pages'
const MOVED = 'Invoice PDF page breaks'
const NOTHING_SPENT = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Options = {
  /** False plays a session with no desktop-app tools (a plain terminal). */
  hasDesktop?: boolean
  /** What the mod's store already holds, as after a reload or a resume. */
  store?: Record<string, unknown>
  /** True plays a session in a git worktree: the app's description of it names one. */
  worktree?: boolean
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
    /** Make the next read, or the next title write, never get an answer from the app. */
    hang: undefined as 'read' | 'rename' | undefined,
    /** How many title writes the app refuses before it takes them again. */
    failRenames: 0,
    /** Refuse every title write as when the person's approval is needed: in the engine's words, or the app's own. */
    approval: undefined as 'engine' | 'app' | undefined,
    /** How many title writes were tried. */
    writes: 0,
    /** How many prompts the person has sent: 1 is a new session, more is one with a history. */
    turns: 5,
    /** The conversation so far, as the engine reports it. */
    messages: [] as SessionMessage[],
    /** What the small model is asked, newest last. */
    asked: [] as string[],
    /** What it answers to each question, in turn; SAME once they run out. 'none' plays a call that gets no answer. */
    answers: [] as string[],
    /** Holds the next question back until `release` is called. */
    hold: false,
    release: () => {},
    settle: () => clock.settle(),
    advance: (ms: number) => clock.advance(ms),
  }

  on('session.id', () => ({ value: 'test-session' }))
  on('session.turns', () => ({ value: w.turns }))
  on('session.messages', () => ({ value: w.messages }))
  on('model.complete', async (_, e) => {
    w.asked.push(e.prompt)
    if (w.hold) {
      w.hold = false
      await new Promise<void>(resolve => {
        w.release = resolve
      })
    }
    const text = w.answers.shift() ?? 'SAME'
    if (text === 'none') return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: NOTHING_SPENT } }
    return { value: { isAnswered: true, text, usage: NOTHING_SPENT } }
  })
  on('command.register', () => ({ value: { command: 'ship-status' } }))
  on('mcp.call', async (_, e) => {
    if (options.hasDesktop === false || e.server !== 'ccd_session_mgmt') return { deny: 'no such server' }
    if (e.tool === 'get_session') {
      if (w.hang === 'read') {
        w.hang = undefined
        await new Promise<never>(() => {})
      }
      const session = options.worktree === true ? { title: w.title, worktreeName: 'work-1' } : { title: w.title }
      return { value: { content: [{ type: 'text', text: JSON.stringify(session) }], isError: false } }
    }
    w.writes += 1
    if (w.approval === 'engine') {
      return { deny: "mcp__ccd_session_mgmt__set_session_title wasn't run: this call needs a person's approval, and a mod's own call can't ask for it." }
    }
    if (w.approval === 'app') {
      const text = "Could not rename this session: its title was set by the user, and replacing it needs their approval, which isn't available in this context."
      return { value: { content: [{ type: 'text', text }], isError: true } }
    }
    if (w.hang === 'rename') {
      w.hang = undefined
      await new Promise<never>(() => {})
    }
    if (w.failRenames > 0) {
      w.failRenames -= 1
      return { value: { content: [{ type: 'text', text: 'declined' }], isError: true } }
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
  expect(off.text).toContain('icon is off the title')
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
  expect(w.titles).toEqual([]) // nothing is written at a start: the app is not ready, and resets titles a little later

  await startTurn($) // the first event of the session puts the mark back
  await w.settle()
  expect(w.titles.at(-1)).toBe(`${BUILD} ${BASE}`)

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

test('one line that pushes, deletes the branch and re-points the upstream finishes the ship', async ($, on) => {
  const w = world(on)
  await start($)
  await ship($)
  await bash($, 'git commit -m x')
  w.nextTool = { isError: false, text: 'To https://example.invalid/repo.git\n   1a2b3c4..5d6e7f8  claude/x -> master\n' }
  await bash(
    $,
    'B=$(git branch --show-current); git fetch -q origin master; git merge-base --is-ancestor origin/master HEAD && git push origin $B:master 2>&1 | tail -2; git push origin --delete $B 2>&1 | tail -1; git branch --set-upstream-to=origin/master',
  )
  await endTurn($)
  await w.settle()
  expect(w.title).toBe(`${CHECK} ${BASE}`)
})

test('a title the app resets after the turn is put back a moment later', async ($, on) => {
  const w = world(on)
  await start($)
  await ship($)
  await bash($, 'git push origin x:master')
  await endTurn($)
  await w.settle()
  expect(w.title).toBe(`${CHECK} ${BASE}`)

  w.title = BASE // the app resets it, as it did in the same second as a finished ship
  await w.advance(2000) // the mod looks again a moment after the turn
  await w.settle()
  expect(w.title).toBe(`${CHECK} ${BASE}`)
})

test('a new name from the app is kept, with the icon in front of it', async ($, on) => {
  const w = world(on)
  await start($)
  await ship($)
  await bash($, 'git add a.cs')
  await endTurn($)
  await w.settle()
  expect(w.title).toBe(`${HAND}${STAGE} ${BASE}`)

  w.title = 'Report export polish' // the app made up a new title
  await w.advance(2000)
  await w.settle()
  expect(w.title).toBe(`${HAND}${STAGE} Report export polish`)
})

test('after a resume the first turn puts the marks back on a reset title', async ($, on) => {
  const w = world(on, {
    store: {
      'cfg:test-session': { isOn: true, base: BASE },
      'run:test-session': { active: false, step: 6, strong: 6, phase: 'done', pushed: true },
    },
  })
  w.title = BASE // the resume reset the title to plain
  await start($)
  await w.advance(5000)
  await w.settle()
  expect(w.titles).toEqual([]) // quiet until the person does something

  await typed($, 'one more thing')
  await startTurn($)
  await w.settle()
  expect(w.title).toBe(`${BOLT} ${BASE}`)
})

test('a title write the app never answers does not silence the ones after it', async ($, on) => {
  const w = world(on)
  await start($)
  w.hang = 'rename'
  await ship($) // the first write hangs
  await w.settle()
  expect(w.titles).toEqual([])

  await w.advance(7000) // the mod gives up on it after 6 s and writes again
  await w.settle()
  expect(w.title).toBe(`${SHIP} ${BASE}`)

  await bash($, 'git fetch')
  await w.settle()
  expect(w.title).toBe(`${SYNC} ${BASE}`)
})

test('two refused title writes quiet the mod only until the next ship-it, which tries again', async ($, on) => {
  const w = world(on)
  await start($)
  w.failRenames = 2
  await ship($)
  await w.settle()
  expect(w.titles).toEqual([])
  expect((await slash($, '')).text).toContain('stopped after two failures')

  await bash($, 'git fetch')
  await w.settle()
  expect(w.titles).toEqual([]) // still quiet

  await ship($) // a new run starts from a clean slate
  await w.settle()
  expect(w.title).toBe(`${SHIP} ${BASE}`)
  expect((await slash($, '')).text).toContain('can be changed')
})

test('a title the app wants approval for is not written again: the mod says so once and keeps the status line', async ($, on) => {
  const w = world(on)
  await start($)
  w.approval = 'engine'
  await ship($)
  await w.settle()
  expect(w.titles).toEqual([])
  expect(w.writes).toBe(1) // one try: asking again changes nothing
  expect(w.statuses.at(-1)).toBe(`${SHIP} ship-it Starting`)
  const said = w.logs.filter(line => line.includes('needs your approval'))
  expect(said).toHaveLength(1)
  expect(said[0]).toContain(`ask Claude to rename this session to "${SHIP} ${BASE}"`)
  expect(said[0]).toContain('/ship-status on')

  await bash($, 'git fetch')
  await w.settle()
  expect(w.writes).toBe(1) // still quiet
  expect(w.statuses.at(-1)).toBe(`${SYNC} ship-it 1/7 Sync`)
  const state = (await slash($, '')).text
  expect(state).toContain('wants your approval')
  expect(state).toContain(`rename this session to "${SYNC} ${BASE}"`)
  expect((await slash($, 'log')).text).toContain("wants the person's approval")

  w.approval = undefined // the person approved a rename Claude made, so the app no longer counts the title as theirs
  await slash($, 'on')
  await w.settle()
  expect(w.title).toBe(`${SYNC} ${BASE}`)
  expect((await slash($, '')).text).toContain('can be changed')
})

test("the app's own refusal of a title the person set is handled the same way", async ($, on) => {
  const w = world(on)
  await start($)
  w.approval = 'app'
  await ship($)
  await w.settle()
  expect(w.titles).toEqual([])
  expect(w.writes).toBe(1)
  expect(w.logs.filter(line => line.includes('needs your approval'))).toHaveLength(1)
  expect((await slash($, '')).text).toContain('wants your approval')
})

test('the next ship-it tries a title the app refused for approval again', async ($, on) => {
  const w = world(on)
  await start($)
  w.approval = 'engine'
  await ship($)
  await w.settle()
  expect(w.titles).toEqual([])

  w.approval = undefined
  await ship($)
  await w.settle()
  expect(w.title).toBe(`${SHIP} ${BASE}`)
})

test('a new worktree session gets the bolt once the app has named it, and the first ship-it carries on from there', async ($, on) => {
  const w = world(on, { worktree: true })
  w.turns = 1
  await start($)
  await startTurn($) // the first prompt
  await w.advance(7000)
  await w.settle()
  expect(w.titles).toEqual([]) // the app is given its moment to name the session first
  await w.advance(2000)
  await w.settle()
  expect(w.title).toBe(`${BOLT} ${BASE}`)
  expect(w.statuses).toEqual([]) // the bolt on the title says it: nothing is pinned
  const state = (await slash($, '')).text
  expect(state).toContain('a status icon in front of the title')
  expect(state).toContain(`${BOLT} new work`)
  expect(state).not.toContain('since the last ship-it')

  await ship($)
  await w.settle()
  expect(w.title).toBe(`${SHIP} ${BASE}`)
})

test('a new session waits for the app to name it', async ($, on) => {
  const w = world(on, { worktree: true })
  w.turns = 1
  w.title = '' // not named yet
  await start($)
  await startTurn($)
  await w.advance(8000)
  await w.settle()
  expect(w.titles).toEqual([])
  w.title = BASE // now it is
  await w.advance(4000)
  await w.settle()
  expect(w.title).toBe(`${BOLT} ${BASE}`)
})

test('a new session the app never names is left alone', async ($, on) => {
  const w = world(on, { worktree: true })
  w.turns = 1
  w.title = ''
  await start($)
  await startTurn($)
  await w.advance(60000)
  await w.settle()
  expect(w.titles).toEqual([])
  expect((await slash($, 'log')).text).toContain('gave it no name')
})

test('a new session outside a worktree gets the bolt too', async ($, on) => {
  const w = world(on)
  w.turns = 1
  await start($)
  await startTurn($)
  await w.advance(9000)
  await w.settle()
  expect(w.title).toBe(`${BOLT} ${BASE}`)
  expect((await slash($, '')).text).toContain('a status icon in front of the title')
})

test('a session that already has a history is left to its first ship-it', async ($, on) => {
  const w = world(on, { worktree: true }) // five prompts behind it
  await start($)
  await startTurn($)
  await w.advance(20000)
  await w.settle()
  expect(w.titles).toEqual([])
  expect(w.writes).toBe(0)
})

test('a session the person marked off is not given a bolt', async ($, on) => {
  const w = world(on, { worktree: true, store: { 'cfg:test-session': { isOn: false, base: BASE } } })
  w.turns = 1
  await start($)
  await startTurn($)
  await w.advance(20000)
  await w.settle()
  expect(w.titles).toEqual([])
})

test('a ship-it that starts before the bolt goes on takes the session in hand', async ($, on) => {
  const w = world(on, { worktree: true })
  w.turns = 1
  await start($)
  await startTurn($)
  await ship($)
  await w.settle()
  expect(w.title).toBe(`${SHIP} ${BASE}`)
  await w.advance(20000)
  await w.settle()
  expect(w.title).toBe(`${SHIP} ${BASE}`) // no late bolt over the ship
})

test('a title the person already gave the bolt is taken as it is', async ($, on) => {
  const w = world(on, { worktree: true })
  w.turns = 1
  w.title = `${BOLT} ${BASE}`
  await start($)
  await startTurn($)
  await w.advance(9000)
  await w.settle()
  expect(w.title).toBe(`${BOLT} ${BASE}`)
  await ship($)
  await w.settle()
  expect(w.title).toBe(`${SHIP} ${BASE}`) // the icon was not taken for part of the name
})

test('a bolt the app wants approval for is noted but not announced, and the first ship-it says so', async ($, on) => {
  const w = world(on, { worktree: true })
  w.turns = 1
  w.approval = 'engine'
  await start($)
  await startTurn($)
  await w.advance(9000)
  await w.settle()
  expect(w.titles).toEqual([])
  expect(w.writes).toBe(1)
  expect(w.logs.filter(line => line.includes('needs your approval'))).toEqual([]) // nobody asked for it
  expect((await slash($, '')).text).toContain('wants your approval')

  await ship($) // the person's own ship-it is worth an explanation
  await w.settle()
  expect(w.writes).toBe(2)
  expect(w.logs.filter(line => line.includes('needs your approval'))).toHaveLength(1)
})

test('a title read the app never answers does not hold up ship-it', async ($, on) => {
  const w = world(on)
  await start($)
  w.hang = 'read'
  const starting = ship($)
  await w.advance(5000) // the read is given 4 s
  await starting
  await w.settle()
  expect(w.statuses.at(-1)).toBe(`${SHIP} ship-it Starting`)
  expect(w.titles).toEqual([])
  expect(w.logs.some(line => line.includes('cannot reach'))).toBe(true)
})

test('/ship-status log says what the mod did', async ($, on) => {
  const w = world(on)
  await start($)
  await ship($)
  await bash($, 'git fetch')
  await w.settle()
  const log = (await slash($, 'log')).text
  expect(log).toContain('ship-it starts')
  expect(log).toContain('title set')
  expect(log).toContain('shows step 1')
})

test('the mod stays quiet about titles until a ship-it has started', async ($, on) => {
  const w = world(on)
  await start($)
  await typed($, 'hello')
  await startTurn($)
  await endTurn($)
  await w.advance(5000)
  await w.settle()
  expect(w.titles).toEqual([])
  expect(w.statuses).toEqual([])
})

// ---- the words of the title follow the work -----------------------------------

const said = (role: 'user' | 'assistant', text: string): SessionMessage => ({ role, text, toolUses: [] })

/** A session the mod has put the bolt on: new, named by the app, and nine seconds into its first prompt. */
async function boltOn($: Engine, w: ReturnType<typeof world>): Promise<void> {
  w.turns = 1
  await start($)
  await startTurn($)
  await w.advance(9000)
  await w.settle()
  expect(w.title).toBe(`${BOLT} ${BASE}`)
}

test('the title follows the work: a prompt that moves to another task renames the session behind its icon', async ($, on) => {
  const w = world(on)
  await boltOn($, w)
  w.messages = [said('user', 'Add CSV export to the reports page'), said('assistant', 'Done: the export button is in.')]
  w.answers = [`NEW: "${MOVED}."`]
  await typed($, LONG)
  await w.settle()
  expect(w.title).toBe(`${BOLT} ${MOVED}`)
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]).toContain(`Current title: ${BASE}`)
  expect(w.asked[0]).toContain('[user] Add CSV export to the reports page')
  expect(w.asked[0]).toContain('[assistant] Done: the export button is in.')
  expect(w.asked[0]).toContain(`[user] ${LONG}`)
  const state = (await slash($, '')).text
  expect(state).toContain('Title words: on')
  expect(state).toContain(`"${BASE}" became "${MOVED}"`)
  expect((await slash($, 'log')).text).toContain(`topic: "${BASE}" -> "${MOVED}"`)

  await ship($) // a ship-it carries on from the new words
  await w.settle()
  expect(w.title).toBe(`${SHIP} ${MOVED}`)
})

test('a prompt on the same task leaves the words alone and writes nothing', async ($, on) => {
  const w = world(on)
  await boltOn($, w)
  const writes = w.writes
  await typed($, 'Also make the export button blue, please')
  await w.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.writes).toBe(writes)
  expect(w.title).toBe(`${BOLT} ${BASE}`)
  expect((await slash($, 'topic')).text).toContain('still fits')
})

test('an answer that only rewords the title changes nothing', async ($, on) => {
  const w = world(on)
  await boltOn($, w)
  const writes = w.writes
  w.answers = ['NEW: add CSV export.']
  await typed($, LONG)
  await w.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.writes).toBe(writes)
})

test('slash commands, short answers and prompts the person did not type are not asked about', async ($, on) => {
  const w = world(on)
  await boltOn($, w)
  await typed($, '/review the whole repository again')
  await typed($, 'yes')
  await $.prompt.submit({ text: LONG, command: { name: 'model', args: '' }, wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: LONG, isMeta: true, wait: false, origin: { kind: 'task-notification' } })
  await w.settle()
  expect(w.asked).toEqual([])
})

test('no question is asked while a ship-it is under way', async ($, on) => {
  const w = world(on)
  await boltOn($, w)
  await ship($)
  await typed($, LONG)
  await w.settle()
  expect(w.asked).toEqual([])
})

test('a session nothing has marked is not asked about', async ($, on) => {
  const w = world(on) // five prompts behind it, and no ship-it yet
  await start($)
  await typed($, LONG)
  await w.settle()
  expect(w.asked).toEqual([])
})

test('a model that gives no answer three times in a row stops the checks until /ship-status topic now', async ($, on) => {
  const w = world(on)
  await boltOn($, w)
  w.answers = ['none', 'none', 'none']
  for (const text of [`${LONG} one`, `${LONG} two`, `${LONG} three`]) {
    await typed($, text)
    await w.settle()
  }
  expect(w.asked).toHaveLength(3)
  expect(w.logs.filter(line => line.includes('gave no answer'))).toHaveLength(1)
  expect((await slash($, 'topic')).text).toContain('stopped')

  await typed($, `${LONG} four`)
  await w.settle()
  expect(w.asked).toHaveLength(3) // not asked again

  w.messages = [said('user', 'Work on dark mode for the settings page')]
  w.answers = ['NEW: Dark mode for settings']
  expect((await slash($, 'topic now')).text).toContain('Dark mode for settings')
  await w.settle()
  expect(w.title).toBe(`${BOLT} Dark mode for settings`)
})

test('a title the app wants approval for is explained once, and the checks stop there', async ($, on) => {
  const w = world(on)
  await boltOn($, w)
  w.approval = 'engine'
  w.answers = [`NEW: ${MOVED}`]
  await typed($, LONG)
  await w.settle()
  expect(w.title).toBe(`${BOLT} ${BASE}`)
  const told = w.logs.filter(line => line.includes('treats it as one you set'))
  expect(told).toHaveLength(1)
  expect(told[0]).toContain(`rename this session to "${BOLT} ${MOVED}"`)

  await typed($, `${LONG} again`)
  await w.settle()
  expect(w.asked).toHaveLength(1) // no point asking when the answer cannot be used
})

test('/ship-status topic off keeps the words, and on brings the checks back', async ($, on) => {
  const w = world(on)
  await boltOn($, w)
  expect((await slash($, 'topic off')).text).toContain('stay as they are')
  await typed($, LONG)
  await w.settle()
  expect(w.asked).toEqual([])
  expect((await slash($, 'topic')).text).toContain('off for this session')
  expect((await slash($, '')).text).toContain('Title words: off')

  expect((await slash($, 'topic on')).text).toContain('follows the work again')
  w.answers = [`NEW: ${MOVED}`]
  await typed($, `${LONG} again`)
  await w.settle()
  expect(w.title).toBe(`${BOLT} ${MOVED}`)
})

test('the choice not to follow the work comes back after a reload, and /ship-status on keeps it', async ($, on) => {
  const w = world(on, {
    store: {
      'cfg:test-session': { isOn: true, base: BASE, isTopicOff: true },
      'run:test-session': { active: false, step: 0, strong: 0, phase: 'working', pushed: false },
    },
  })
  await start($)
  await typed($, LONG)
  await w.settle()
  expect(w.asked).toEqual([])

  await slash($, 'on')
  await typed($, `${LONG} again`)
  await w.settle()
  expect(w.asked).toEqual([])
})

test('a check that finishes after ship-status was turned off changes nothing', async ($, on) => {
  const w = world(on)
  await boltOn($, w)
  w.hold = true
  w.answers = [`NEW: ${MOVED}`]
  await typed($, LONG)
  await w.settle() // the model is still thinking
  expect(w.asked).toHaveLength(1)
  await slash($, 'off')
  await w.settle()
  w.release()
  await w.settle()
  expect(w.title).toBe(BASE)
  expect(w.titles.some(title => title.includes(MOVED))).toBe(false)
  expect((await slash($, 'log')).text).toContain('dropped')
})

test('a question the model never answers does not stop the next one for good', async ($, on) => {
  const w = world(on)
  await boltOn($, w)
  w.hold = true
  await typed($, LONG)
  await w.settle()
  expect(w.asked).toHaveLength(1)
  await typed($, `${LONG} again`)
  await w.settle()
  expect(w.asked).toHaveLength(1) // one question at a time

  await w.advance(61000) // the mod gives up waiting
  await w.settle()
  w.answers = [`NEW: ${MOVED}`]
  await typed($, `${LONG} once more`)
  await w.settle()
  expect(w.asked).toHaveLength(2)
  expect(w.title).toBe(`${BOLT} ${MOVED}`)
})

test('a ship-it that begins while the model is thinking keeps its own title', async ($, on) => {
  const w = world(on)
  await boltOn($, w)
  w.hold = true
  w.answers = [`NEW: ${MOVED}`]
  await typed($, LONG)
  await w.settle()
  expect(w.asked).toHaveLength(1) // the model is thinking
  await ship($)
  await w.settle()
  expect(w.title).toBe(`${SHIP} ${BASE}`)
  w.release()
  await w.settle()
  expect(w.title).toBe(`${SHIP} ${BASE}`)
  expect((await slash($, 'log')).text).toContain('dropped')
})
