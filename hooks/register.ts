import type { EngineInterface, McpToolResult, Register, Timer } from 'claude-code'

import { DEMO, LAST_STEP, bare, classify, cleanWords, following, fresh, idle, marked, marksNewSession, needsApproval, newWork, parseCfg, parseRun, parseTopic, pause, recent, resume, settle, started, starting, statusFor, titleFor, topicPrompt, topicRules, worthChecking } from './steps'
import type { Cfg, NewSessionMark, Run } from './steps'

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
// A new session wears the bolt from its first prompt, so nobody has to type it in: a title typed by hand
// counts as the person's, and the app then asks for their approval before a mod may change it. 'worktree'
// marks only the sessions in a git worktree, 'never' leaves a session alone until its first ship-it.
const NEW_SESSION_MARK: NewSessionMark = 'always'
// The app names a new session a moment after its first prompt, and a name given before that would stop it
// from naming the session at all, so marking waits for the app's name.
const NEW_SESSION_DELAY_MS = 8000
const NEW_SESSION_RETRY_MS = 4000
const NEW_SESSION_TRIES = 8

// The words of the title follow the work. At each prompt the person types, a small model reads the latest
// messages and says whether the session has moved on to a different task than its title names; if it has, it
// names the new one, and the icon stays in front. TOPIC_TITLES false leaves the words of the title alone.
const TOPIC_TITLES = true
const TOPIC_MODEL = 'haiku'
const TOPIC_MAX_CHARS = 40 // the distinctive words come first, so a title the sidebar clips still tells sessions apart
const TOPIC_MIN_PROMPT_CHARS = 8 // "yes" and "do it" cannot change the subject
const TOPIC_LINES = 6 // how many of the latest messages the model reads
const TOPIC_LINE_CHARS = 300
const TOPIC_TIMEOUT_MS = 20000
const TOPIC_MAX_FAILURES = 3 // answers missing in a row before the checks stop; /ship-status topic now tries again

const USAGE = [
  '/ship-status                where ship-it stands and how this session is being marked',
  '/ship-status demo           preview every step on the title',
  '/ship-status on | off       put the icon on the title, or leave the title alone',
  '/ship-status topic          whether the words of the title follow the work, and what the last check said',
  '/ship-status topic on | off | now   follow the work, stop following it, or check this moment',
  '/ship-status rename <words>   set the words of the title by hand; the icon stays in front and the checks leave them alone',
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
let pumping: Promise<void> | undefined // the write in flight, for a command that tells the person how it went
let pumpId = 0
let canRename = true
let misses = 0
let sidebarNote = '' // the last thing that went wrong with the sidebar title, '' when nothing has
let isApprovalNeeded = false // the app wants the person's approval to change this title, so writing again cannot help
let isQuietAsk = false // the write on its way was nobody's request (a re-check, a new session's bolt): a refusal is noted, not announced

let verifyTimer: Timer | undefined
let reasserts = 0

let isNewSessionChecked = false // the first turn was looked at: a session is only ever taken for a new one once
let newSessionTimer: Timer | undefined

let isTopicChecking = false // the model is being asked: one question at a time
let topicId = 0 // which question is the live one, so that a late answer to a forgotten question cannot free the next
let topicFailures = 0 // answers missing in a row
let isTopicBroken = false // too many missing: the checks have stopped
let lastTopic = '' // what the last check came to, for /ship-status topic

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

/** What the app says about this session: its title (undefined while it has none) and whether it lives in a git worktree. */
type SessionFacts = { title: string | undefined; isWorktree: boolean }

async function readSession($: EngineInterface): Promise<SessionFacts | undefined> {
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
    const parsed: unknown = JSON.parse(textOf(result))
    const fields = typeof parsed === 'object' && parsed !== null ? (parsed as { title?: unknown; worktreeName?: unknown }) : {}
    const title = typeof fields.title === 'string' ? fields.title : undefined
    if (title !== undefined) sidebarNote = ''
    return { title, isWorktree: typeof fields.worktreeName === 'string' && fields.worktreeName !== '' }
  } catch {
    note('could not read the title: the answer was not JSON')
    return undefined
  }
}

async function readTitle($: EngineInterface): Promise<string | undefined> {
  return (await readSession($))?.title
}

async function rename($: EngineInterface, title: string): Promise<string | undefined> {
  const result = await callApp($, 'set_session_title', { session_id: 'self', title }, RENAME_TIMEOUT_MS)
  if (typeof result === 'string') return result
  return result.isError ? textOf(result) || 'the app refused the new title' : undefined
}

function renameRequest(title: string | undefined): string {
  return title === undefined ? 'rename this session' : `rename this session to "${title}"`
}

// A mod cannot ask the person to approve a change, but Claude can: the app then asks the person, and
// once they approve, the title is no longer one the app counts as theirs, so the mod can carry on.
function approvalAdvice(title: string | undefined): string {
  return (
    "could not change this session's title: the app treats it as one you set (an icon typed in by hand counts), " +
    'so a change needs your approval, and a mod cannot ask for that. ' +
    `To allow it once, ask Claude to ${renameRequest(title)}, approve the app's prompt, then run /ship-status on. ` +
    'Until then progress shows in the status line.'
  )
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
      if (needsApproval(problem)) {
        // Not a glitch: the same write is refused every time. Stop at once, and say what would help.
        isApprovalNeeded = true
        canRename = false
        note(`the app wants the person's approval to change the title: ${problem}`)
        if (!isQuietAsk) $.ui.log(`ship-status: ${approvalAdvice(title)}`)
        break
      }
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
function requestTitle($: EngineInterface, title: string, isQuiet = false): void {
  wanted = title
  isQuietAsk = isQuiet
  if (!isPumping) pumping = pump($)
}

// A new ship-it, /ship-status on, step and demo each start from a clean slate: a title write that
// failed or hung earlier must not keep the mod quiet for the rest of the session.
function resetTitleState(): void {
  pumpId += 1 // abandons a write still waiting on the app
  isPumping = false
  demoId += 1 // and a demo still running
  isDemoing = false
  canRename = true
  isApprovalNeeded = false
  misses = 0
  applied = undefined
  sidebarNote = ''
  reasserts = 0
  isNewSessionChecked = true // whoever started this took the session in hand: no bolt of the mod's own accord
  newSessionTimer?.cancel()
  newSessionTimer = undefined
  topicFailures = 0 // and the model gets another chance
  isTopicBroken = false
}

// ---- showing the run -------------------------------------------------------

function render($: EngineInterface, isQuiet = false): void {
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
  if (cfg !== undefined && canRename) requestTitle($, titleFor(cfg.base, run), isQuiet)

  const needsYou = run.phase === 'failed' || run.phase === 'conflict'
  const mark = `${run.step}:${run.phase}`
  if (needsYou && toasted !== mark) {
    toasted = mark
    $.ui.toast(statusFor(run))
  } else if (!needsYou) {
    toasted = ''
  }
}

function commit($: EngineInterface, isQuiet = false): void {
  persist($)
  render($, isQuiet)
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
  if (cfg !== undefined) requestTitle($, titleFor(cfg.base, run), true)
}

// ---- a new session ---------------------------------------------------------

// The first turn of a new session starts the clock for its bolt. A session with prompts behind it (a
// resume, an older one) is only marked by its first ship-it or /ship-status on.
async function noticeNewSession($: EngineInterface): Promise<void> {
  if (isNewSessionChecked) return
  isNewSessionChecked = true
  if (cfg !== undefined || run.phase !== 'idle' || !marksNewSession(NEW_SESSION_MARK, true)) return
  try {
    if ((await $.session.turns()) > 1) return
    scheduleNewSession($, NEW_SESSION_DELAY_MS, NEW_SESSION_TRIES)
  } catch (error) {
    debug($, `could not tell whether this session is new: ${message(error)}`)
  }
}

function scheduleNewSession($: EngineInterface, delayMs: number, tries: number): void {
  newSessionTimer?.cancel()
  newSessionTimer = $.clock.after(delayMs, () => {
    newSessionTimer = undefined
    void markNewSession($, tries)
  })
}

// Puts the bolt on a new session once the app has named it. A ship-it or /ship-status that got there first
// has taken the session in hand, and a refusal here is noted but not announced: nobody asked for it.
async function markNewSession($: EngineInterface, tries: number): Promise<void> {
  try {
    if (cfg !== undefined || run.phase !== 'idle' || isDemoing) return
    const session = await readSession($)
    if (session === undefined || cfg !== undefined || run.phase !== 'idle' || isDemoing) return
    if (!marksNewSession(NEW_SESSION_MARK, session.isWorktree)) {
      note(`new session left alone: ${session.isWorktree ? '' : 'not '}in a worktree, marking is ${NEW_SESSION_MARK}`)
      return
    }
    const base = bare(session.title ?? '')
    if (base === '') {
      if (tries > 1) scheduleNewSession($, NEW_SESSION_RETRY_MS, tries - 1) // the app has not named it yet
      else note('new session: the app gave it no name, so it is left alone')
      return
    }
    note(`new session "${base}": the bolt goes on, from its first prompt`)
    cfg = marked(cfg, true, base)
    run = fresh()
    commit($, true)
    scheduleVerify($)
  } catch (error) {
    debug($, `could not mark a new session: ${message(error)}`)
  }
}

// ---- the words of the title ------------------------------------------------

// At each prompt the person types, once the session is marked: has the work moved on from what the title
// says? Nothing waits for the answer. The prompt goes on its way, and the title changes a moment later if it should.
function noticeTopic($: EngineInterface, text: string): void {
  if (!TOPIC_TITLES || isTopicBroken || isTopicChecking || cfg?.isOn !== true || cfg.isTopicOff === true) return
  if (run.active || !shouldMark() || !worthChecking(text, TOPIC_MIN_PROMPT_CHARS)) return
  checkTopic($, text).catch(error => debug($, `title check failed: ${message(error)}`))
}

function topicFailed($: EngineInterface, why: string): string {
  topicFailures += 1
  note(`topic: no answer (${topicFailures} of ${TOPIC_MAX_FAILURES}): ${why}`)
  if (topicFailures >= TOPIC_MAX_FAILURES && !isTopicBroken) {
    isTopicBroken = true
    lastTopic = 'stopped, the model gave no answer'
    $.ui.log(`ship-status: the model gave no answer ${TOPIC_MAX_FAILURES} times in a row (${why}), so the words of the title stay as they are. /ship-status topic now tries again.`)
  }
  return `The model gave no answer: ${why}`
}

// Asks the small model whether the newest request (`prompt`; empty for the conversation as it stands) moves the
// session to a different task than its title names, and puts the new name behind the icon if it does.
async function checkTopic($: EngineInterface, prompt: string): Promise<string> {
  const before = cfg
  if (before === undefined || !before.isOn) return 'ship-status is not marking this session, so there is no title to keep up. /ship-status on starts it.'
  if (isTopicChecking) return 'A check is already running.'
  const id = ++topicId
  isTopicChecking = true
  // A call that never comes back must not stop the checks for the rest of the session.
  const watchdog = $.clock.after(TOPIC_TIMEOUT_MS * 3, () => {
    if (id === topicId) isTopicChecking = false
  })
  try {
    let history: readonly { role: string; text: string }[] = []
    try {
      history = await $.session.messages()
    } catch (error) {
      note(`topic: could not read the conversation: ${message(error)}`) // the prompt alone is still something to go on
    }
    const said = recent(history, prompt, TOPIC_LINES, TOPIC_LINE_CHARS)
    if (said.length === 0) return 'Nothing has been said yet to go on.'
    const reply = await $.model.complete({
      model: TOPIC_MODEL,
      system: topicRules(TOPIC_MAX_CHARS),
      prompt: topicPrompt(before.base, said),
      maxTokens: 80,
      effort: 'low',
      timeoutMs: TOPIC_TIMEOUT_MS,
    })
    if (!reply.isAnswered) {
      return topicFailed($, reply.reason === 'api-error' ? `api-error ${reply.status ?? 'with no response'}, ${reply.error}` : reply.reason)
    }
    topicFailures = 0
    const title = parseTopic(reply.text, before.base, TOPIC_MAX_CHARS)
    if (title === undefined) {
      lastTopic = 'the work still fits the title'
      note(`topic: the work still fits "${before.base}"`)
      return `The work still fits "${before.base}".`
    }
    const now = cfg
    if (now === undefined || !now.isOn || now.base !== before.base || run.active || isDemoing || !canRename) {
      note(`topic: "${title}" dropped, the session changed while the model was thinking`)
      return 'The session changed while the model was thinking, so the title was left alone.'
    }
    cfg = marked(now, true, title)
    lastTopic = `"${now.base}" became "${title}"`
    note(`topic: "${now.base}" -> "${title}"`)
    commit($)
    scheduleVerify($)
    return `The title is now "${title}".`
  } catch (error) {
    return topicFailed($, message(error))
  } finally {
    watchdog.cancel()
    if (id === topicId) isTopicChecking = false
  }
}

function topicState(): string {
  if (!TOPIC_TITLES) return 'off: TOPIC_TITLES is false in the mod'
  if (cfg === undefined) return 'not started yet: it begins once the session is marked'
  if (cfg.isTopicOff === true) return 'off for this session (/ship-status topic on turns it back on)'
  if (!cfg.isOn) return 'waiting: ship-status is off for this session (/ship-status on)'
  if (isTopicBroken) return 'stopped: the model gave no answer several times in a row (/ship-status topic now tries again)'
  const last = lastTopic === '' ? 'nothing checked yet' : `last check: ${lastTopic}`
  return `on: a small model reads each prompt you type and renames the session when the work moves on (${last})`
}

async function setTopic($: EngineInterface, arg: string): Promise<string> {
  const word = arg.trim().toLowerCase()
  if (word === '') return `Title words: ${topicState()}`
  if (word === 'on' || word === 'off') {
    if (cfg === undefined) return 'ship-status is not marking this session yet: the first ship-it or /ship-status on starts it.'
    cfg = following(cfg, word === 'on')
    persist($)
    if (word === 'off') return 'The words of the title stay as they are from now on, whatever the work does. The icon still follows ship-it.'
    isTopicBroken = false
    topicFailures = 0
    return 'The title follows the work again: a small model reads each prompt you type and renames the session when the work moves on.'
  }
  if (word === 'now') {
    if (cfg?.isOn !== true) return 'ship-status is not marking this session, so there is no title to keep up. /ship-status on starts it.'
    if (!canRename) return 'The app is not taking title changes right now: /ship-status says why.'
    isTopicBroken = false
    topicFailures = 0
    return checkTopic($, '')
  }
  return USAGE
}

// The person sets the words of the title by hand. The mod writes them, so the title stays one it may change
// later (a title typed into the sidebar counts as the person's, and the app then asks for their approval
// every time), and the title check keeps out of the way until /ship-status topic on.
async function setWords($: EngineInterface, arg: string): Promise<string> {
  const words = cleanWords(arg)
  if (words === '') {
    return `Give the new words: /ship-status rename <words>. The icon stays in front${cfg === undefined ? '' : `; the words read "${cfg.base}" now`}.`
  }
  resetTitleState()
  const isMarking = cfg?.isOn !== false
  cfg = following(marked(cfg, isMarking, words), false)
  if (isMarking && run.phase === 'idle') run = fresh() // a session nothing has marked yet wears the bolt now
  note(`renamed by hand: "${words}"`)
  if (isMarking) {
    commit($, true)
    scheduleVerify($)
  } else {
    persist($)
    requestTitle($, words, true)
  }
  await pumping
  const shown = isMarking ? titleFor(words, run) : words
  if (applied === shown) {
    return `The title is now "${shown}". The words are yours: the title check leaves them alone until /ship-status topic on.`
  }
  if (isApprovalNeeded) return approvalAdvice(shown)
  return `The app did not take the new title${sidebarNote === '' ? '' : ` (${sidebarNote})`}. /ship-status says more.`
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
  return marked(cfg, true, bare(current))
}

// ---- /ship-status ----------------------------------------------------------

function startNote(mode: NewSessionMark): string {
  switch (mode) {
    case 'always':
      return 'a new session gets the bolt from its first prompt, and the first ship-it puts its icon on'
    case 'worktree':
      return 'a new worktree session gets the bolt from its first prompt, and the first ship-it puts its icon on'
    default:
      return 'the first ship-it puts the icon on'
  }
}

function describe(): string {
  const marking =
    cfg === undefined
      ? `not started yet (${startNote(NEW_SESSION_MARK)})`
      : cfg.isOn
        ? 'a status icon in front of the title'
        : 'off (/ship-status on turns it back on)'
  const progress = run.phase === 'idle' ? 'no ship-it run in this session yet' : statusFor(run)
  const sidebar = isApprovalNeeded
    ? `the app wants your approval (it counts the title as one you set): ask Claude to ${renameRequest(cfg === undefined ? wanted : titleFor(cfg.base, run))}, approve the prompt, then run /ship-status on`
    : !canRename
      ? `stopped after two failures (${sidebarNote}); the next /ship-it or /ship-status on tries again`
      : sidebarNote !== ''
        ? `trouble: ${sidebarNote}`
        : 'can be changed'
  return [`Marking: ${marking}`, `ship-it: ${progress}`, `Title words: ${topicState()}`, `Sidebar title: ${sidebar}`].join('\n')
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
    cfg = marked(cfg, false, cfg?.base ?? '')
    persist($)
    return 'ship-status is off: the icon is off the title (its words stay as they are) and neither ship-it nor the title check will touch it. /ship-status on turns it on again.'
  }
  resetTitleState()
  const current = await readTitle($)
  if (current === undefined && cfg === undefined) return "Cannot read this session's title, so there is nothing to mark."
  cfg = marked(cfg, true, current === undefined ? (cfg?.base ?? '') : bare(current))
  commit($)
  scheduleVerify($)
  return "ship-status is on: the icon goes on this session's title, ship-it moves it along, and the words follow the work."
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
        description: "Show or adjust how /ship-it progress and the session's work are marked on its title",
        argumentHint: '[demo | on | off | topic | rename | step | log]',
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
      await noticeNewSession($)
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
      noticeTopic($, e.text)
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
      case 'topic':
        return { text: await setTopic($, arg) }
      case 'rename':
        return { text: await setWords($, arg) }
      case 'step':
        return { text: await setStep($, arg) }
      case 'log':
        return { text: showLog() }
      default:
        return { text: USAGE }
    }
  })
}
