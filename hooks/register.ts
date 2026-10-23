import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import { DEMO, LAST_STEP, bare, begin, classify, idle, newWork, parseCfg, parseRun, pause, resume, settle, started, statusFor, titleFor } from './steps'
import type { Cfg, Run } from './steps'

// The desktop app's own session tools, reached through $.mcp.call. They change
// the sidebar entry's title; in a plain terminal the server is absent and
// ship-status falls back to the status line under the prompt.
const SERVER = 'ccd_session_mgmt'
const DEMO_FRAME_MS = 1500

const USAGE = [
  '/ship-status                where ship-it stands and whether this worktree is being marked',
  '/ship-status demo           preview every step on the title',
  '/ship-status on | off       put the icon on the title, or leave the title alone',
  '/ship-status step <0-7 | wait | fail | conflict | done | work | idle>   set it by hand',
].join('\n')

// What this session decided and where its run stands. A reload of the mod starts
// these over; load() brings the saved copies back from $.store.
let loading: Promise<void> | undefined
let sessionId = ''
let cfg: Cfg | undefined
let run: Run = idle()

let isDemoing = false
let isStatusShown = false
let toasted = ''

// Title writes: the newest wanted title wins, and one write is in flight at a time.
let wanted: string | undefined
let applied: string | undefined
let isPumping = false
let canRename = true
let misses = 0
let sidebarNote = '' // the last thing that went wrong with the sidebar title, '' when nothing has

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function textOf(result: McpToolResult): string {
  return result.content
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
    .trim()
}

function debug($: EngineInterface, text: string): void {
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

async function readTitle($: EngineInterface): Promise<string | undefined> {
  try {
    const result = await $.mcp.call(SERVER, 'get_session', { session_id: 'self' })
    if (result.isError) return undefined
    const session: unknown = JSON.parse(textOf(result))
    const title = typeof session === 'object' && session !== null ? (session as { title?: unknown }).title : undefined
    if (typeof title === 'string') sidebarNote = ''
    return typeof title === 'string' ? title : undefined
  } catch {
    return undefined
  }
}

async function rename($: EngineInterface, title: string): Promise<string | undefined> {
  try {
    const result = await $.mcp.call(SERVER, 'set_session_title', { session_id: 'self', title })
    return result.isError ? textOf(result) || 'the app refused the new title' : undefined
  } catch (error) {
    return message(error)
  }
}

async function pump($: EngineInterface): Promise<void> {
  isPumping = true
  try {
    while (canRename && wanted !== undefined && wanted !== applied) {
      const title = wanted
      applied = title
      const problem = await rename($, title)
      if (problem === undefined) {
        misses = 0
        sidebarNote = ''
        continue
      }
      applied = undefined
      sidebarNote = problem
      misses += 1
      if (misses >= 2) {
        canRename = false
        $.ui.log(`ship-status: could not change the sidebar title (${problem}); progress shows in the status line only.`)
      }
    }
  } catch (error) {
    debug($, `title update failed: ${message(error)}`)
  } finally {
    isPumping = false
  }
}

// Never awaited by a hook: a slow or waiting app must not hold up a tool call.
function requestTitle($: EngineInterface, title: string): void {
  wanted = title
  if (!isPumping) void pump($)
}

// ---- showing the run -------------------------------------------------------

function render($: EngineInterface): void {
  if (isDemoing || run.phase === 'idle' || cfg?.isOn === false) return
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

// How this session is marked. The title is read again at the start of every run,
// so a rename made by hand since the last one becomes the new base. Without a
// desktop-app title to read there is nothing to put an icon on: only the status
// line is used then.
async function choice($: EngineInterface): Promise<Cfg | undefined> {
  if (cfg?.isOn === false) return cfg
  const current = await readTitle($)
  if (current === undefined) {
    sidebarNote = 'this session has no desktop-app title to read'
    $.ui.log("ship-status: cannot reach the desktop app's session tools here, so the sidebar title is left alone; progress shows in the status line.")
    return cfg
  }
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
  const sidebar = !canRename ? `stopped after two failures (${sidebarNote})` : sidebarNote !== '' ? `trouble: ${sidebarNote}` : 'can be changed'
  return [`Worktree marking: ${marked}`, `ship-it: ${progress}`, `Sidebar title: ${sidebar}`].join('\n')
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
  canRename = true
  misses = 0
  isDemoing = true
  let index = 0
  const tick = (): void => {
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
  const current = await readTitle($)
  if (current === undefined && cfg === undefined) return "Cannot read this session's title, so there is nothing to mark."
  cfg = { isOn: true, base: current === undefined ? (cfg?.base ?? '') : bare(current) }
  commit($)
  return 'ship-status is on: ship-it puts its icon on this worktree from now on.'
}

async function setStep($: EngineInterface, arg: string): Promise<string> {
  const word = arg.trim().toLowerCase()
  if (word === '') return USAGE
  if (cfg?.isOn === false) return 'ship-status is off for this session; run /ship-status on first.'
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
  return run.phase === 'idle' ? 'Cleared.' : statusFor(run)
}

// ---- hooks -----------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'ship-status',
        description: 'Show or adjust how /ship-it progress is marked on this worktree',
        argumentHint: '[demo | on | off | step]',
      })
    } catch (error) {
      debug($, `could not register /ship-status: ${message(error)}`)
    }
    await load($)
    if (run.active) render($) // a reload in the middle of a run puts its marks back
    return next(e)
  })

  on('skill.prompt', { skill: /(?:^|:)ship-it$/ }, async ($, e, next) => {
    try {
      await load($)
      cfg = await choice($)
      run = started()
      toasted = ''
      commit($)
    } catch (error) {
      debug($, `could not start tracking ship-it: ${message(error)}`)
    }
    return next(e)
  })

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    await load($)
    if (!run.active || typeof e.command !== 'string') return next(e)
    const kinds = classify(e.command)
    const last = kinds[kinds.length - 1]
    if (last === undefined) return next(e)

    for (const kind of kinds) run = begin(run, kind)
    commit($)

    const ran = await next(e)
    try {
      if (ran.deny === undefined) {
        run = settle(run, last, { isError: ran.isError === true, text: ran.text ?? '' })
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
      default:
        return { text: USAGE }
    }
  })
}
