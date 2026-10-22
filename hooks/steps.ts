// ship-status: the pure half.
//
// Which step of ~/.claude/commands/ship-it.md a shell command belongs to, how a
// run moves from step to step, and what the worktree's title and the status
// line say about it. Nothing here touches `$`, so ship.test.ts checks it
// directly and register.ts only wires it to the engine.

export type Phase = 'idle' | 'running' | 'waiting' | 'failed' | 'conflict' | 'done'

/** How this session's title is marked. */
export type Cfg = {
  /** False once the person ran `/ship-status off`: the title is left alone. */
  isOn: boolean
  /** The title as it stood without an icon: what `off` puts back. */
  base: string
}

/** Where one /ship-it run stands. */
export type Run = {
  active: boolean
  /** The step shown: 0 (just started) to LAST_STEP. */
  step: number
  /**
   * The furthest step a command has proved. `step` can sit ahead of it for a
   * moment (a look at `git status` before the build), and a command for an
   * earlier step never pulls `step` back behind it.
   */
  strong: number
  phase: Phase
  /** The branch reached master: the ship worked even if clean-up never ran. */
  pushed: boolean
}

// Steps, numbered as ship-it.md numbers them; 0 is "just started". The icons
// are single code points (no joiners or variation selectors) on purpose.
export const STEPS: readonly { icon: string; label: string }[] = [
  { icon: '\u{1F6A2}', label: 'Starting' }, // ship
  { icon: '\u{1F504}', label: 'Sync' }, // arrows in a circle
  { icon: '\u{1F500}', label: 'Merge master' }, // shuffle
  { icon: '\u{1F528}', label: 'Build' }, // hammer
  { icon: '\u{1F4CB}', label: 'Stage' }, // clipboard
  { icon: '\u{1F4DD}', label: 'Commit' }, // memo
  { icon: '\u{1F680}', label: 'Push to master' }, // rocket
  { icon: '\u{1F9F9}', label: 'Clean up' }, // broom
]
export const LAST_STEP = STEPS.length - 1

const PHASE_ICON = {
  waiting: '\u{270B}', // raised hand: it is your move
  failed: '\u{274C}', // cross mark
  conflict: '\u{1F6A7}', // construction sign
  done: '\u{2705}', // check mark
} as const

const COMMITTED = 5

export const idle = (): Run => ({ active: false, step: 0, strong: 0, phase: 'idle', pushed: false })
export const started = (): Run => ({ ...idle(), active: true, phase: 'running' })

// ---------------------------------------------------------------------------
// Reading a shell command

export type Kind =
  | 'sync' // git fetch, git pull                          step 1
  | 'merge' // git merge <ref>                              step 2
  | 'build' // the project's build                          step 3
  | 'look' // git status, git diff                         step 4, as a look only
  | 'stage' // git add, rm, mv                              step 4
  | 'commit' // git commit                                  step 5
  | 'fetch-ref' // git fetch origin master                  step 6's divergence check
  | 'merge-base' // git merge-base --is-ancestor            step 6's divergence check
  | 'push' // git push origin <branch>:master               step 6
  | 'delete' // git push origin --delete <branch>          step 7
  | 'upstream' // git branch --set-upstream-to              step 7

/** Extra patterns that count as the build step; add the project's own script here. */
export const BUILD_HINTS: RegExp[] = []

const BUILD_TOOLS = new Set([
  'msbuild', 'nmake', 'make', 'cmake', 'ninja', 'tsc', 'webpack', 'rollup', 'xcodebuild',
  'ant', 'gradle', 'gradlew', 'mvn', 'mvnw', 'bazel', 'invoke-build',
])
const RUNNERS = new Set(['dotnet', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'swift', 'ng', 'next', 'nuxt', 'vite', 'nx', 'turbo'])
const BUILD_VERB = /^(?:build|msbuild|compile|package|publish)(?:[:-]|$)/
const INTERPRETERS = new Set(['powershell', 'pwsh', 'bash', 'sh', 'zsh', 'cmd', 'node'])
const WRAPPERS = new Set(['sudo', 'time', 'command', 'exec', 'nohup', 'env'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const GIT_VALUE_OPTIONS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'])

/** The step kinds of every command in a shell line, in the order written. */
export function classify(command: string): Kind[] {
  const kinds: Kind[] = []
  for (const part of split(command)) {
    const kind = kindOf(part)
    if (kind !== undefined) kinds.push(kind)
  }
  return kinds
}

/** Splits a shell line at `;` `|` `&` and newlines that sit outside quotes. */
function split(command: string): string[] {
  const parts: string[] = []
  let part = ''
  let quote = ''
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i)
    if (quote !== '') {
      part += c
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") {
      quote = c
      part += c
    } else if (c === ';' || c === '|' || c === '&' || c === '\n') {
      parts.push(part)
      part = ''
      if ((c === '&' || c === '|') && command.charAt(i + 1) === c) i++
    } else {
      part += c
    }
  }
  parts.push(part)
  return parts.map(p => p.trim()).filter(p => p !== '')
}

/** Words of one command, quotes removed, a quoted run staying one word. */
function words(part: string): string[] {
  const out: string[] = []
  let word = ''
  let quote = ''
  let isOpen = false
  for (const c of part) {
    if (quote !== '') {
      if (c === quote) quote = ''
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      isOpen = true
    } else if (/\s/.test(c)) {
      if (isOpen) out.push(word)
      word = ''
      isOpen = false
    } else {
      word += c
      isOpen = true
    }
  }
  if (isOpen) out.push(word)
  return out
}

/** A program's bare name: no folder, no extension, lower case. */
function base(word: string): string {
  const file = word.split(/[\\/]/).pop() ?? word
  return file.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1|sh)$/, '')
}

function kindOf(part: string): Kind | undefined {
  const all = words(part)
  let i = 0
  while (i < all.length && (ASSIGNMENT.test(all[i] ?? '') || WRAPPERS.has(base(all[i] ?? '')))) i++
  const command = all.slice(i)
  if (command.length === 0) return undefined
  if (base(command[0] ?? '') === 'git') return gitKind(command.slice(1))
  return isBuild(command) || BUILD_HINTS.some(hint => hint.test(part)) ? 'build' : undefined
}

const BUILD_SCRIPT = /^build(?:[-_.]|$)/

function isBuild(command: string[]): boolean {
  const [first = '', second = '', third = ''] = command.map(base)
  if (BUILD_TOOLS.has(first) || BUILD_SCRIPT.test(first)) return true
  if (RUNNERS.has(first)) return BUILD_VERB.test(second) || (second === 'run' && BUILD_VERB.test(third))
  if (INTERPRETERS.has(first)) {
    // pwsh -File build.ps1, cmd /c build.cmd, bash ./build.sh: the script is the first word that is not a switch
    const script = command.slice(1).find(word => !/^[-/]/.test(word))
    return script !== undefined && BUILD_SCRIPT.test(base(script))
  }
  return false
}

function gitKind(args: string[]): Kind | undefined {
  let i = 0
  while (i < args.length && (args[i] ?? '').startsWith('-')) i += GIT_VALUE_OPTIONS.has(args[i] ?? '') ? 2 : 1
  const sub = (args[i] ?? '').toLowerCase()
  const rest = args.slice(i + 1)
  const has = (...names: string[]): boolean => rest.some(a => names.some(n => a === n || a.startsWith(`${n}=`)))
  const positional = rest.filter(a => !a.startsWith('-'))

  switch (sub) {
    case 'pull':
      return 'sync'
    case 'fetch':
      return positional.length >= 2 ? 'fetch-ref' : 'sync'
    case 'merge':
      return has('--abort', '--quit') ? undefined : 'merge'
    case 'merge-base':
      return 'merge-base'
    case 'status':
    case 'diff':
      return 'look'
    case 'add':
    case 'rm':
    case 'mv':
      return 'stage'
    case 'commit':
      return has('--dry-run') ? undefined : 'commit'
    case 'push':
      if (has('--dry-run')) return undefined
      return has('--delete', '-d') || positional.some(a => a.startsWith(':')) ? 'delete' : 'push'
    case 'branch':
      return has('--set-upstream-to', '--set-upstream', '-u', '--unset-upstream') ? 'upstream' : undefined
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Moving a run

/** Where a command puts the display: its step, and whether it is only a look. */
function target(kind: Kind, strong: number): { step: number; isLook?: true } | undefined {
  const isCommitted = strong >= COMMITTED
  switch (kind) {
    case 'sync':
      return { step: 1 }
    case 'fetch-ref':
      return { step: isCommitted ? 6 : 1 }
    case 'merge':
      return { step: isCommitted ? 6 : 2 }
    case 'merge-base':
      return isCommitted ? { step: 6 } : undefined
    case 'build':
      return isCommitted ? undefined : { step: 3 }
    case 'look':
      return strong >= 2 && strong <= 3 ? { step: 4, isLook: true } : undefined
    case 'stage':
      return { step: 4 }
    case 'commit':
      return { step: 5 }
    case 'push':
      return { step: 6 }
    case 'delete':
    case 'upstream':
      return { step: 7 }
  }
}

/** A command is about to run: show its step. A command for an earlier step shows nothing new. */
export function begin(run: Run, kind: Kind): Run {
  if (!run.active) return run
  const to = target(kind, run.strong)
  if (to === undefined) return run
  if (to.isLook === true) return { ...run, step: to.step, phase: 'running' }
  if (to.step < run.strong) return { ...run, phase: 'running' }
  return { ...run, step: to.step, strong: to.step, phase: 'running' }
}

export type Outcome = { isError: boolean; text: string }

const CONFLICT = /CONFLICT \(|Automatic merge failed|fix conflicts and then commit|Merge conflict in/i
const BUILD_FAILED =
  /\bBuild FAILED\b|FAILURE: Build failed|\berror (?:CS|MSB|TS|NU|BC|FS|VB|LNK|C)\d{2,5}\b|\bnpm ERR!|error: could not compile|\berror\[E\d{4}\]|\*\*\* \[[^\]]*\] Error \d+/i

/** Whether a finished command stopped the ship, and how. */
function failure(kind: Kind, out: Outcome): 'failed' | 'conflict' | undefined {
  switch (kind) {
    case 'sync':
    case 'merge':
      if (CONFLICT.test(out.text)) return 'conflict'
      return out.isError ? 'failed' : undefined
    case 'build':
      return out.isError || BUILD_FAILED.test(out.text) ? 'failed' : undefined
    case 'fetch-ref':
    case 'stage':
    case 'commit':
    case 'push':
      return out.isError ? 'failed' : undefined
    default:
      // a look, merge-base (exit 1 means "master moved"), and the clean-up
      // commands, which ship-it.md says never undo a ship
      return undefined
  }
}

/** A command finished: record a failure, a push, or the end of the clean-up. */
export function settle(run: Run, kind: Kind, out: Outcome): Run {
  if (!run.active) return run
  const bad = failure(kind, out)
  if (bad !== undefined) return { ...run, phase: bad }
  if (kind === 'push') return { ...run, pushed: true }
  if (kind === 'delete' && run.pushed && !out.isError) return { ...run, phase: 'done', active: false }
  return run
}

/** The turn ended: shipped if the branch reached master, otherwise it is waiting on the person. */
export function pause(run: Run): Run {
  if (!run.active) return run
  if (run.phase === 'failed' || run.phase === 'conflict') return run
  if (run.pushed) return { ...run, phase: 'done', active: false }
  return { ...run, phase: 'waiting' }
}

/** A new turn began: the person has answered, so it is no longer waiting on them. */
export function resume(run: Run): Run {
  return run.active && run.phase === 'waiting' ? { ...run, phase: 'running' } : run
}

// ---------------------------------------------------------------------------
// What the person sees

const TITLE_LIMIT = 120
// Built from a code point so the source stays plain ASCII.
const ELLIPSIS = String.fromCodePoint(0x2026)

function clip(text: string): string {
  const chars = Array.from(text)
  return chars.length <= TITLE_LIMIT ? text : `${chars.slice(0, TITLE_LIMIT - 1).join('')}${ELLIPSIS}`
}

function stepOf(run: Run): { icon: string; label: string } {
  return STEPS[run.step] ?? STEPS[0] ?? { icon: '', label: '' }
}

/** The icon or icons in front of the title: the step's, with the phase's ahead of it when it needs you. */
export function marks(run: Run): string {
  if (run.phase === 'done') return PHASE_ICON.done
  if (run.phase === 'idle' || run.phase === 'running') return stepOf(run).icon
  return PHASE_ICON[run.phase] + stepOf(run).icon
}

function where(run: Run): string {
  return run.step === 0 ? 'Starting' : `${run.step}/${LAST_STEP} ${stepOf(run).label}`
}

/** The sidebar title for a run: its icon or icons in front of the title as it stood. */
export function titleFor(base: string, run: Run): string {
  return clip([marks(run), base].filter(part => part !== '').join(' '))
}

/** The line pinned under the prompt. */
export function statusFor(run: Run): string {
  const m = marks(run)
  switch (run.phase) {
    case 'done':
      return `${m} ship-it: shipped`
    case 'waiting':
      return `${m} ship-it ${where(run)}: waiting for you`
    case 'failed':
      return `${m} ship-it ${where(run)}: failed`
    case 'conflict':
      return `${m} ship-it ${where(run)}: merge conflicts`
    default:
      return `${m} ship-it ${where(run)}`
  }
}

const DECORATION = new RegExp(`^[${[...STEPS.map(s => s.icon), ...Object.values(PHASE_ICON)].join('')}]+\\s+`, 'u')

/** A title with the icons ship-status put in front of it taken off again. */
export function bare(title: string): string {
  return title.replace(DECORATION, '').trim()
}

const frame = (phase: Phase, step: number): Run => ({
  active: phase !== 'done',
  step,
  strong: step,
  phase,
  pushed: phase === 'done',
})

/** A walk through every kind of moment, for `/ship-status demo`. */
export const DEMO: readonly Run[] = [
  frame('running', 0),
  frame('running', 1),
  frame('running', 2),
  frame('conflict', 2),
  frame('running', 3),
  frame('failed', 3),
  frame('running', 4),
  frame('waiting', 5),
  frame('running', 5),
  frame('waiting', 6),
  frame('running', 6),
  frame('running', 7),
  frame('done', 7),
]

// ---------------------------------------------------------------------------
// What was saved

const PHASES: readonly string[] = ['idle', 'running', 'waiting', 'failed', 'conflict', 'done']

export function parseCfg(raw: unknown): Cfg | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { isOn, base: title } = raw as Record<string, unknown>
  return typeof isOn === 'boolean' && typeof title === 'string' ? { isOn, base: title } : undefined
}

export function parseRun(raw: unknown): Run | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { active, step, strong, phase, pushed } = raw as Record<string, unknown>
  const isStep = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= LAST_STEP
  if (typeof active !== 'boolean' || !isStep(step) || !isStep(strong)) return undefined
  if (typeof phase !== 'string' || !PHASES.includes(phase)) return undefined
  return { active, step, strong, phase: phase as Phase, pushed: pushed === true }
}
