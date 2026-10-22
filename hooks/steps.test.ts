import { describe, expect, test } from 'claude-code/testing'

import { DEMO, bare, begin, classify, idle, parseCfg, parseRun, pause, resume, settle, started, statusFor, titleFor } from './steps'
import type { Kind, Outcome, Run } from './steps'

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
const SIGN = '\u{1F6A7}'
const CHECK = '\u{2705}'

const OK: Outcome = { isError: false, text: '' }

/** One command the way the hook sees it: every step it names begins, then the last one settles. */
function play(run: Run, command: string, out: Outcome = OK): Run {
  const kinds = classify(command)
  const last = kinds[kinds.length - 1]
  if (last === undefined) return run
  let next = run
  for (const kind of kinds) next = begin(next, kind)
  return settle(next, last, out)
}

const at = (run: Run): string => `${run.step}/${run.phase}`

describe('reading a shell command', () => {
  const cases: [string, string, Kind[]][] = [
    ['fetch', 'git fetch', ['sync']],
    ['fetch origin', 'git fetch origin', ['sync']],
    ['fetch all', 'git fetch --all --prune', ['sync']],
    ['pull', 'git pull', ['sync']],
    ['chained with &&', 'git fetch && git pull', ['sync', 'sync']],
    ['chained with ; (PowerShell)', 'git fetch; git merge origin/master', ['sync', 'merge']],
    ['merge', 'git merge origin/master', ['merge']],
    ['merge abort is not a step', 'git merge --abort', []],
    ['a git option before the subcommand', 'git -C "E:\\a b" status', ['look']],
    ['an environment assignment first', 'GIT_TERMINAL_PROMPT=0 git pull', ['sync']],
    ['a cd before it', 'cd /repo && git fetch', ['sync']],
    ['dotnet build', 'dotnet build', ['build']],
    ['dotnet build piped to a tail', 'dotnet build -c Release 2>&1 | Select-Object -Last 20', ['build']],
    ['npm run build', 'npm run build', ['build']],
    ['npm install is not a build', 'npm install', []],
    ['dotnet test is not a build', 'dotnet test', []],
    ['MSBuild by path', '& "C:\\Program Files\\Microsoft Visual Studio\\2022\\MSBuild\\Bin\\MSBuild.exe" App.sln', ['build']],
    ['a build script through pwsh', 'pwsh -File ./scripts/Build-All.ps1', ['build']],
    ['a build script directly', './build.ps1', ['build']],
    ['a folder called build is not a build', 'ls build/', []],
    ['status', 'git status', ['look']],
    ['diff', 'git diff --stat', ['look']],
    ['log is not a step', 'git log --oneline', []],
    ['add by path', 'git add Site/Views/Home/Index.cshtml', ['stage']],
    ['rm by path', 'git rm Docs/old-spec.md', ['stage']],
    ['commit', 'git commit -m "Application => Area => Description"', ['commit']],
    ['a ; inside a commit message', 'git commit -m "fix: a; git push later"', ['commit']],
    ['commit dry run is not a step', 'git commit --dry-run', []],
    ['a heredoc commit message', ["git commit -m \"$(cat <<'EOF'", 'Fix it', '', 'git push is faster now', 'EOF', ')"'].join('\n'), ['commit']],
    ['fetch of a ref is the divergence check', 'git fetch origin master', ['fetch-ref']],
    ['merge-base', 'git merge-base --is-ancestor origin/master claude/x', ['merge-base']],
    ['push to master', 'git push origin claude/x:master', ['push']],
    ['push HEAD to master', 'git push origin HEAD:master', ['push']],
    ['push dry run is not a step', 'git push --dry-run origin claude/x:master', []],
    ['delete the branch', 'git push origin --delete claude/x', ['delete']],
    ['delete with a colon', 'git push origin :claude/x', ['delete']],
    ['re-point the upstream', 'git branch --set-upstream-to=origin/master', ['upstream']],
    ['showing the branch is not a step', 'git branch --show-current', []],
  ]
  for (const [name, command, kinds] of cases) {
    test(name, () => {
      expect(classify(command)).toEqual(kinds)
    })
  }
})

describe('a ship-it run', () => {
  test('walks the seven steps and finishes shipped', () => {
    let run = started()
    expect(at(run)).toBe('0/running')

    run = play(run, 'git status')
    expect(at(run)).toBe('0/running') // a look before the sync is not the stage step

    run = play(run, 'git fetch')
    expect(at(run)).toBe('1/running')
    run = play(run, 'git pull')
    run = play(run, 'git merge origin/master')
    expect(at(run)).toBe('2/running')
    run = play(run, 'dotnet build')
    expect(at(run)).toBe('3/running')
    run = play(run, 'git status')
    expect(at(run)).toBe('4/running')
    run = play(run, 'git diff')
    run = play(run, 'git add a.cs')
    expect(at(run)).toBe('4/running')

    run = pause(run) // the commit message is shown and the person asked
    expect(at(run)).toBe('4/waiting')
    run = resume(run)
    expect(at(run)).toBe('4/running')

    run = play(run, 'git commit -m "x"')
    expect(at(run)).toBe('5/running')
    run = play(run, 'git fetch origin master')
    expect(at(run)).toBe('6/running')
    run = play(run, 'git merge-base --is-ancestor origin/master claude/x', { isError: true, text: '' })
    expect(at(run)).toBe('6/running') // exit 1 only means master moved
    run = pause(run)
    expect(at(run)).toBe('6/waiting')
    run = resume(run)

    run = play(run, 'git push origin claude/x:master')
    expect(run.pushed).toBe(true)
    run = play(run, 'git push origin --delete claude/x')
    expect(at(run)).toBe('7/done')
    expect(run.active).toBe(false)

    expect(play(run, 'git branch --set-upstream-to=origin/master')).toBe(run) // the run is over
  })

  test('is shipped when the turn ends after the push even if the clean-up never ran', () => {
    let run = started()
    for (const command of ['git fetch', 'git merge origin/master', 'dotnet build', 'git add a.cs', 'git commit -m x', 'git push origin x:master']) {
      run = play(run, command)
    }
    run = pause(run)
    expect(at(run)).toBe('6/done')
    expect(run.active).toBe(false)
  })

  test('a failed delete does not undo the ship', () => {
    let run = started()
    for (const command of ['git commit -m x', 'git push origin x:master']) run = play(run, command)
    run = play(run, 'git push origin --delete x', { isError: true, text: 'remote ref does not exist' })
    expect(run.phase).toBe('running')
    expect(pause(run).phase).toBe('done')
  })

  test('a failed build stops at the build until a build works', () => {
    let run = started()
    run = play(run, 'git merge origin/master')
    run = play(run, 'dotnet build', { isError: true, text: 'Build FAILED.' })
    expect(at(run)).toBe('3/failed')
    expect(at(pause(run))).toBe('3/failed')

    run = play(run, 'dotnet build')
    expect(at(run)).toBe('3/running')
  })

  test('sees a failed build behind a pipe that exits 0', () => {
    let run = started()
    run = play(run, 'dotnet build 2>&1 | Select-Object -Last 5', { isError: false, text: 'Program.cs(12,5): error CS1002: ; expected' })
    expect(at(run)).toBe('3/failed')
    run = play(run, 'dotnet build', { isError: false, text: 'Build succeeded.\n    0 Warning(s)\n    0 Error(s)' })
    expect(at(run)).toBe('3/running')
  })

  test('shows merge conflicts apart from other failures', () => {
    let run = started()
    run = play(run, 'git merge origin/master', {
      isError: true,
      text: 'CONFLICT (content): Merge conflict in Site/Views/Home/Index.cshtml\nAutomatic merge failed; fix conflicts and then commit the result.',
    })
    expect(at(run)).toBe('2/conflict')
    expect(at(pause(run))).toBe('2/conflict')
  })

  test('a push the remote refuses is a failure', () => {
    let run = started()
    run = play(run, 'git commit -m x')
    run = play(run, 'git push origin x:master', { isError: true, text: '! [rejected] x -> master (non-fast-forward)' })
    expect(at(run)).toBe('6/failed')
    expect(run.pushed).toBe(false)
  })

  test('never goes back a step once committed', () => {
    let run = started()
    run = play(run, 'git commit -m x')
    run = play(run, 'git fetch')
    expect(at(run)).toBe('5/running')
    run = play(run, 'git merge origin/master') // master moved: the merge belongs to step 6
    expect(at(run)).toBe('6/running')
    run = play(run, 'dotnet build') // a rebuild changes nothing shown
    expect(at(run)).toBe('6/running')
    run = play(run, 'dotnet build', { isError: true, text: '' })
    expect(at(run)).toBe('6/failed')
  })

  test('an ordinary command does not wake a waiting run, only a new turn does', () => {
    let run = pause(play(started(), 'git fetch'))
    expect(at(run)).toBe('1/waiting')
    run = play(run, 'ls')
    expect(at(run)).toBe('1/waiting')
    expect(at(resume(run))).toBe('1/running')
  })

  test('does nothing when no run is active', () => {
    const run = idle()
    expect(play(run, 'git fetch')).toBe(run)
    expect(pause(run)).toBe(run)
    expect(resume(run)).toBe(run)
  })
})

describe('what the person sees', () => {
  const at3 = (phase: Run['phase']): Run => ({ active: true, step: 3, strong: 3, phase, pushed: false })

  test('the title gets the step icon in front of it', () => {
    expect(titleFor('Add CSV export', { ...started(), step: 0 })).toBe(`${SHIP} Add CSV export`)
    expect(titleFor('Add CSV export', at3('running'))).toBe(`${BUILD} Add CSV export`)
    expect(titleFor('Add CSV export', at3('waiting'))).toBe(`${HAND}${BUILD} Add CSV export`)
    expect(titleFor('Add CSV export', at3('failed'))).toBe(`${CROSS}${BUILD} Add CSV export`)
    expect(titleFor('Add CSV export', at3('conflict'))).toBe(`${SIGN}${BUILD} Add CSV export`)
    expect(titleFor('Add CSV export', { ...at3('done'), step: 7 })).toBe(`${CHECK} Add CSV export`)
  })

  test('every step has its own icon', () => {
    const icons = [SHIP, SYNC, MERGE, BUILD, STAGE, COMMIT, PUSH, CLEAN]
    icons.forEach((icon, step) => {
      expect(titleFor('t', { active: true, step, strong: step, phase: 'running', pushed: false })).toBe(`${icon} t`)
    })
  })

  test('an empty title leaves no stray space', () => {
    expect(titleFor('', at3('running'))).toBe(BUILD)
  })

  test('a very long title is cut', () => {
    const title = titleFor('x'.repeat(500), at3('running'))
    expect(Array.from(title).length).toBe(120)
    expect(title.endsWith('\u2026')).toBe(true)
  })

  test('the status line says what is happening', () => {
    expect(statusFor(at3('running'))).toBe(`${BUILD} ship-it 3/7 Build`)
    expect(statusFor(at3('waiting'))).toBe(`${HAND}${BUILD} ship-it 3/7 Build: waiting for you`)
    expect(statusFor(at3('failed'))).toBe(`${CROSS}${BUILD} ship-it 3/7 Build: failed`)
    expect(statusFor(at3('conflict'))).toBe(`${SIGN}${BUILD} ship-it 3/7 Build: merge conflicts`)
    expect(statusFor({ ...at3('done'), step: 7 })).toBe(`${CHECK} ship-it: shipped`)
    expect(statusFor(started())).toBe(`${SHIP} ship-it Starting`)
  })

  test('bare takes the icons back off a title', () => {
    expect(bare(`${BUILD} Add CSV export`)).toBe('Add CSV export')
    expect(bare(`${HAND}${COMMIT} Add CSV export`)).toBe('Add CSV export')
    expect(bare(`${CHECK} Add CSV export`)).toBe('Add CSV export')
    expect(bare('Plain title')).toBe('Plain title')
    expect(bare('Fix the 3/7 split')).toBe('Fix the 3/7 split')
  })

  test('the demo shows each icon and each moment that needs the person', () => {
    const titles = DEMO.map(run => titleFor('t', run))
    for (const icon of [SHIP, SYNC, MERGE, BUILD, STAGE, COMMIT, PUSH, CLEAN, CHECK]) {
      expect(titles.some(title => title.includes(icon))).toBe(true)
    }
    for (const mark of [HAND, CROSS, SIGN]) expect(titles.some(title => title.includes(mark))).toBe(true)
  })
})

describe('what was saved', () => {
  test('a saved choice comes back', () => {
    expect(parseCfg({ isOn: true, base: 'a' })).toEqual({ isOn: true, base: 'a' })
    expect(parseCfg({ isOn: false, base: '' })).toEqual({ isOn: false, base: '' })
  })

  test('nonsense is not a choice', () => {
    expect(parseCfg(null)).toBeUndefined()
    expect(parseCfg('on')).toBeUndefined()
    expect(parseCfg({ isOn: 'yes', base: 'a' })).toBeUndefined()
    expect(parseCfg({ isOn: true })).toBeUndefined()
  })

  test('a saved run comes back, nonsense does not', () => {
    const run: Run = { active: true, step: 4, strong: 3, phase: 'waiting', pushed: false }
    expect(parseRun(run)).toEqual(run)
    expect(parseRun({ ...run, step: 99 })).toBeUndefined()
    expect(parseRun({ ...run, phase: 'sparkle' })).toBeUndefined()
    expect(parseRun({ ...run, active: 'yes' })).toBeUndefined()
    expect(parseRun(undefined)).toBeUndefined()
  })
})
