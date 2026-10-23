import type { EngineInterface, McpToolResult, Register, Timer } from 'claude-code'

import { DEMO, LAST_STEP, bare, classify, idle, newWork, parseCfg, parseRun, pause, resume, settle, started, starting, statusFor, titleFor } from './steps'
import type { Cfg, Run } from './steps'

// The desktop app's own session tools, reached through $.mcp.call. They change
// the sidebar entry's title; in a plain terminal the server is absent and
// ship-status falls back to the status line under the prompt.
const SERVER = 'ccd_session_mgmt'
const DEMO_FRAME_MS = 1500
// Asking the app for the title, and telling it the new one, must never be able to hang the mod.
const READ_TIMEOUT_MS = 4000
const RENAME_TIMEOUT_MS = 6000
// The app resets titles behind the mod's back (on a resume, and sometimes as a turn ends), so a moment
// after each turn boundary the title is read again and put back if it is not what was last set.
const VERIFY_DELAY_MS = 1500
const MAX_REASSERTS = 3
const NOTE_LIMIT = 60

const USAGE = [
  '/ship-status                where ship-it stands and whether this worktree is being marked',
  '/ship-status demo           preview every step on the title',
  '/ship-status on | off       put the icon on the title, or leave the title alone',
  '/ship-status step <0-7 | wait | fail | conflict | done | work | idle>   set it by hand',
  '/ship-status log            what the mod did lately, for when something looks wrong',
].join('\n')

// What this session decided and where its run stands. A reload of the mod starts
// these over; load() brings the saved copies back from $.store.
let loading: Promise<void> | undefined
let sessionId = ''
let cfg: Cfg | undefined
let run: Run = idle()

let isDemoing = false
let demoId = 0
let isStatusShown = false
let toasted = ''
let lastShown = ''

// Title writes: the newest wanted title wins, and one write is in flight at a time.
let wanted: string | undefined
let applied: string | undefined
let isPumping = false
let pumpId = 0
let canRename = true
let misses = 0
let sidebarNote = '' // the last thing that went wrong with the sidebar title, '' when nothing has

let verifyTimer: Timer | undefined
let reasserts = 0

const notes: string[] = []

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function textOf(result: McpToolResult): string {
  return result.content
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
    .trim()
}

// A short memory of what the mod did, for /ship-status log.
function note(text: string): void {
  let at = '--:--:--'
  try {
    at = new Date().toISOString().slice(11, 19)
  } catch {
    // no clock in this environment: the placeholder stays
  }
  notes.push(`${at} ${text}`)
  if (notes.length > NOTE_LIMIT) notes.shift()
}

function debug($: EngineInterface, text: string): void {
  note(text)
  $.ui.log(`ship-status: ${text}`, { to: 'debug' })
}

function key(name: 'cfg' | 'run'): string {
  return `${name}:${sessionId}`
}

// ---- saved state -----------------------------------------------------------

function load($: EngineInterface): Promise<void> {
  loading ??= restore($)
  return loading
}

async function restore($: EngineInterface): Promise<void> {
  try {
    sessionId = await $.session.id()
    cfg = parseCfg(await $.store.get(key('cfg')))
    run = parseRun(await $.store.get(key('run'))) ?? idle()
    note(`loaded: marking ${cfg === undefined ? 'not chosen' : cfg.isOn ? 'on' : 'off'}, run ${run.phase}`)
  } catch (error) {
    debug($, `could not restore its state: ${message(error)}`)
  }
}

function persist($: EngineInterface): void {
  if (sessionId === '') return
  const writes = [$.store.set(key('run'), run)]
  if (cfg !== undefined) writes.push($.store.set(key('cfg'), cfg))
  Promise.all(writes).catch(error => debug($, `could not save its state: ${message(error)}`))
}

// ---- the sidebar title -----------------------------------------------------

// Calls the desktop app's session tool, giving up after `ms`: a slow or hung app must not hold up the mod.
function callApp($: EngineInterface, tool: string, args: Record<string, unknown>, ms: number): Promise<McpToolResult | string> {
  return new Promise(resolve => {
    const timer = $.clock.after(ms, () => resolve(`no answer from the app after ${ms / 1000}s`))
    $.mcp.call(SERVER, tool, args).then(
      result => {
        timer.cancel()
        resolve(result)
      },
      error => {
        timer.cancel()
        resolve(message(error))
      },
    )
  })
}

async function readTitle($: EngineInterface): Promise<string | undefined> {
  const result = await callApp($, 'get_session', { session_id: 'self' }, READ_TIMEOUT_MS)
  if (typeof result === 'string') {
    note(`could not read the title: ${result}`)
    return undefined
  }
  if (result.isError) {
    note(`could not read the title: ${textOf(result) || 'the app reported an error'}`)
    return undefined
  }
  try {
    const session: unknown = JSON.parse(textOf(result))
    const title = typeof session === 'object' && session !== null ? (session as { title?: unknown }).title : undefined
    if (typeof title !== 'string') return undefined
    sidebarNote = ''
    return title
  } catch {
    note('could not read the title: the answer was not JSON')
    return undefined
  }
}

async function rename($: EngineInterface, title: string): Promise<string | undefined> {
  const result = await callApp($, 'set_session_title', { session_id: 'self', title }, RENAME_TIMEOUT_MS)
  if (typeof result === 'string') return result
  return result.isError ? textOf(result) || 'the app refused the new title' : undefined
}

async function pump($: EngineInterface): Promise<void> {
  const id = ++pumpId
  isPumping = true
  try {
    while (id === pumpId && canRename && wanted !== undefined && wanted !== applied) {
      const title = wanted
      const problem = await rename($, title)
      if (id !== pumpId) return // a new ship-it started meanwhile and took over
      if (problem === undefined) {
        applied = title
        misses = 0
        sidebarNote = ''
        note(`title set: ${title}`)
        continue
      }
      sidebarNote = problem
      misses += 1
      note(`could not set the title (try ${misses}): ${problem}`)
      if (misses >= 2) {
        canRename = false
        $.ui.log(`ship-status: could not change the sidebar title (${problem}); progress shows in the status line until the next /ship-it.`)
      }
    }
  } catch (error) {
    debug($, `title update failed: ${message(error)}`)
  } finally {
    if (id === pumpId) isPumping = false
  }
}

// Never awaited by a hook: a slow or waiting app must not hold up a tool call.
function requestTitle($: EngineInterface, title: string): void {
  wanted = title
  if (!isPumping) void pump($)
}

// A new ship-it, /ship-status on, step and demo each start from a clean slate: a title write that
// failed or hung earlier must not keep the mod quiet for the rest of the session.
function resetTitleState(): void {
  pumpId += 1 // abandons a write still waiting on the app
  isPumping = false
  demoId += 1 // and a demo still running
  isDemoing = false
  canRename = true
  misses = 0
  applied = undefined
  sidebarNote = ''
  reasserts = 0
}

// ---- showing the run -------------------------------------------------------

function render($: EngineInterface): void {
  if (isDemoing || run.phase === 'idle' || cfg?.isOn === false) return
  reasserts = 0
  const shown = `${run.step}:${run.phase}`
  if (shown !== lastShown) {
    lastShown = shown
    note(`shows step ${run.step}, ${run.phase}`)
  }
  if (run.phase === 'working') {
    clearStatus($) // the icon on the title says it; nothing needs pinning under the prompt
  } else {
    $.ui.status(statusFor(run))
    isStatusShown = true
  }
  if (cfg !== undefined && canRename) requestTitle($, titleFor(cfg.base, run))

  const needsYou = run.phase === 'failed' || run.phase === 'conflict'
  const mark = `${run.step}:${run.phase}`
  if (needsYou && toasted !== mark) {
    toasted = mark
    $.ui.toast(statusFor(run))
  } else if (!needsYou) {
    toasted = ''
  }
}

function commit($: EngineInterface): void {
  persist($)
  render($)
}

function clearStatus($: EngineInterface): void {
  if (!isStatusShown) return
  isStatusShown = false
  $.ui.status(undefined)
}

// ---- keeping the title as it was set ---------------------------------------

function shouldMark(): boolean {
  return cfg?.isOn === true && run.phase !== 'idle' && !isDemoing && canRename
}

// A moment after a turn boundary, look at the title again (debounced: the newest call wins).
function scheduleVerify($: EngineInterface): void {
  verifyTimer?.cancel()
  verifyTimer = undefined
  if (!shouldMark()) return
  verifyTimer = $.clock.after(VERIFY_DELAY_MS, () => {
    verifyTimer = undefined
    void verify($)
  })
}

// Puts the title back when something else changed it. A new name (the person's, or one the app made up)
// becomes the new base; a title that only lost its icon gets the icon again.
async function verify($: EngineInterface): Promise<void> {
  if (!shouldMark()) return
  if (isPumping) {
    scheduleVerify($) // a write is still in flight: look again once it has landed
    return
  }
  const live = await readTitle($)
  const current = cfg
  if (live === undefined || current === undefined) return
  if (live === titleFor(current.base, run)) return
  if (reasserts >= MAX_REASSERTS) {
    note('the title keeps being changed from outside; leaving it alone')
    return
  }
  reasserts += 1
  const seen = bare(live)
  if (seen !== current.base) {
    note(`the session was renamed to "${seen}"; keeping that name`)
    cfg = { ...current, base: seen }
    persist($)
  } else {
    note('the icon was reset from outside; putting it back')
  }
  applied = undefined
  if (cfg !== undefined) requestTitle($, titleFor(cfg.base, run))
}

// How this session is marked. The title is read again at the start of every run,
// so a rename made by hand since the last one becomes the new base. Without a
// desktop-app title to read there is nothing to put an icon on: only the status
// line is used then.
async function choice($: EngineInterface): Promise<Cfg | undefined> {
  if (cfg?.isOn === false) return cfg
  const current = await readTitle($)
  if (current === undefined) {
    sidebarNote = 'could not read the session title'
    $.ui.log("ship-status: cannot reach the desktop app's session tools right now, so the sidebar title is left alone; progress shows in the status line. /ship-status log has the details.")
    return cfg
  }
  note(`ship-it found the title "${bare(current)}"`)
  return { isOn: true, base: bare(current) }
}

// ---- /ship-status ----------------------------------------------------------

function describe(): string {
  const marked =
    cfg === undefined
      ? 'not started yet (the first ship-it puts the icon on)'
      : cfg.isOn
        ? 'a status icon in front of the title'
        : 'off (/ship-status on turns it back on)'
  const progress = run.phase === 'idle' ? 'no ship-it run in this session yet' : statusFor(run)
  const sidebar = !canRename
    ? `stopped after two failures (${sidebarNote}); the next /ship-it or /ship-status on tries again`
    : sidebarNote !== ''
      ? `trouble: ${sidebarNote}`
      : 'can be changed'
  return [`Worktree marking: ${marked}`, `ship-it: ${progress}`, `Sidebar title: ${sidebar}`].join('\n')
}

function showLog(): string {
  return notes.length === 0 ? 'Nothing logged yet.' : notes.slice(-25).join('\n')
}

async function startDemo($: EngineInterface): Promise<string> {
  if (isDemoing) return 'The demo is already running.'
  let base = cfg?.base
  if (base === undefined) {
    const current = await readTitle($)
    if (current === undefined) return "Cannot read this session's title, so there is nothing to preview."
    base = bare(current)
  }
  const shown = base
  resetTitleState()
  isDemoing = true
  const id = demoId
  let index = 0
  const tick = (): void => {
    if (id !== demoId) return // a ship-it, or another demo, took over
    const frame = DEMO[index++]
    if (frame === undefined) {
      isDemoing = false
      if (run.phase !== 'idle' && cfg?.isOn === true) {
        render($)
      } else {
        requestTitle($, shown)
        clearStatus($)
      }
      return
    }
    if (frame.phase === 'working') {
      clearStatus($) // as for real: the bolt on the title says it
    } else {
      $.ui.status(statusFor(frame))
      isStatusShown = true
    }
    requestTitle($, titleFor(shown, frame))
    $.clock.after(DEMO_FRAME_MS, tick)
  }
  tick()
  return `Previewing ${DEMO.length} moments on this session's title, ${DEMO_FRAME_MS / 1000}s each. It goes back to normal afterwards.`
}

async function setMarking($: EngineInterface, isOn: boolean): Promise<string> {
  if (!isOn) {
    if (cfg?.isOn === true) requestTitle($, cfg.base)
    clearStatus($)
    cfg = { isOn: false, base: cfg?.base ?? '' }
    persist($)
    return 'ship-status is off: the original title is back and ship-it will not touch it. /ship-status on turns it on again.'
  }
  resetTitleState()
  const current = await readTitle($)
  if (current === undefined && cfg === undefined) return "Cannot read this session's title, so there is nothing to mark."
  cfg = { isOn: true, base: current === undefined ? (cfg?.base ?? '') : bare(current) }
  commit($)
  scheduleVerify($)
  return 'ship-status is on: ship-it puts its icon on this worktree from now on.'
}

async function setStep($: EngineInterface, arg: string): Promise<string> {
  const word = arg.trim().toLowerCase()
  if (word === '') return USAGE
  if (cfg?.isOn === false) return 'ship-status is off for this session; run /ship-status on first.'
  resetTitleState()
  cfg = await choice($)

  const live = run.phase === 'idle' ? started() : run
  const n = /^\d+$/.test(word) ? Number(word) : -1
  if (n >= 0 && n <= LAST_STEP) {
    run = { ...started(), step: n, strong: n }
  } else if (word === 'wait') {
    run = { ...live, phase: 'waiting' }
  } else if (word === 'fail') {
    run = { ...live, phase: 'failed' }
  } else if (word === 'conflict') {
    run = { ...live, phase: 'conflict' }
  } else if (word === 'done') {
    run = { ...live, phase: 'done', active: false, pushed: true }
  } else if (word === 'work') {
    run = { ...live, phase: 'working', active: false, pushed: true }
  } else if (word === 'idle') {
    run = idle()
    if (cfg?.isOn === true) requestTitle($, cfg.base)
    clearStatus($)
  } else {
    return USAGE
  }
  commit($)
  scheduleVerify($)
  return run.phase === 'idle' ? 'Cleared.' : statusFor(run)
}

// ---- hooks -----------------------------------------------------------------

export const register: Register = on => {
  // Nothing is written to the title here: right after a start or resume the app is not ready for it,
  // and what it holds is only reset a little later. The first event of the session puts the marks back.
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'ship-status',
        description: 'Show or adjust how /ship-it progress is marked on this worktree',
        argumentHint: '[demo | on | off | step | log]',
      })
    } catch (error) {
      debug($, `could not register /ship-status: ${message(error)}`)
    }
    await load($)
    return next(e)
  })

  on('skill.prompt', { skill: /(?:^|:)ship-it$/ }, async ($, e, next) => {
    try {
      await load($)
      resetTitleState()
      cfg = await choice($)
      run = started()
      toasted = ''
      note(`ship-it starts; marking is ${cfg === undefined ? 'unavailable' : cfg.isOn ? 'on' : 'off'}`)
      commit($)
      scheduleVerify($)
    } catch (error) {
      debug($, `could not start tracking ship-it: ${message(error)}`)
    }
    return next(e)
  })

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    await load($)
    if (!run.active || typeof e.command !== 'string') return next(e)
    const kinds = classify(e.command)
    if (kinds.length === 0) return next(e)

    run = starting(run, kinds)
    commit($)

    const ran = await next(e)
    try {
      if (ran.deny === undefined) {
        run = settle(run, kinds, { isError: ran.isError === true, text: ran.text ?? '' })
      }
      commit($)
    } catch (error) {
      debug($, `could not record ${e.command.slice(0, 40)}: ${message(error)}`)
    }
    return ran
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await load($)
      // A turn that begins after a finished ship (the ship-it turn itself starts a run first) is new work.
      const moved = newWork(resume(run))
      if (moved !== run) {
        run = moved
        commit($)
      }
      scheduleVerify($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await load($)
      const paused = pause(run)
      if (paused !== run) {
        run = paused
        commit($)
      }
      scheduleVerify($)
    }
    return next(e)
  })

  // The "shipped" line has said its piece by the next thing the person types, and a plain
  // prompt after a ship is new work: the check mark gives way to a bolt. A slash command
  // is not (a skill command starts a turn, which turn.start catches), nor is a prompt the
  // person did not type.
  on('prompt.submit', async ($, e, next) => {
    await load($)
    if (!run.active) clearStatus($)
    if (e.command === undefined && e.isMeta !== true) {
      const moved = newWork(run)
      if (moved !== run) {
        run = moved
        commit($)
      }
    }
    scheduleVerify($)
    return next(e)
  })

  on('command.run', { command: 'ship-status' }, async ($, e) => {
    await load($)
    const [word = '', ...rest] = e.args.trim().split(/\s+/).filter(part => part !== '')
    const arg = rest.join(' ')
    switch (word.toLowerCase()) {
      case '':
        return { text: describe() }
      case 'demo':
        return { text: await startDemo($) }
      case 'on':
        return { text: await setMarking($, true) }
      case 'off':
        return { text: await setMarking($, false) }
      case 'step':
        return { text: await setStep($, arg) }
      case 'log':
        return { text: showLog() }
      default:
        return { text: USAGE }
    }
  })
}
