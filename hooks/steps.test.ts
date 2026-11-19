import { describe, expect, test } from 'claude-code/testing'

import { DEMO, bare, classify, cleanTopic, following, fresh, idle, marked, marksNewSession, needsApproval, newWork, parseCfg, parseRun, parseTopic, pause, recent, resume, sameWords, settle, started, starting, statusFor, tidy, titleFor, topicPrompt, topicRules, worthChecking } from './steps'
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
const BOLT = '\u{26A1}'

const OK: Outcome = { isError: false, text: '' }

/** One command line the way the hook sees it: the steps it names begin, then the whole line settles. */
function play(run: Run, command: string, out: Outcome = OK): Run {
  const kinds = classify(command)
  if (kinds.length === 0) return run
  return settle(starting(run, kinds), kinds, out)
}

// What the model really ran at the end of a ship: master check, push, branch delete and upstream in one line.
const CHAIN =
  'B=$(git branch --show-current); git fetch -q origin master; git merge-base --is-ancestor origin/master HEAD && git push origin $B:master 2>&1 | tail -2; git push origin --delete $B 2>&1 | tail -1; git branch --set-upstream-to=origin/master'
const PUSHED = 'To https://example.invalid/repo.git\n   1a2b3c4..5d6e7f8  claude/x -> master\n'

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

  test('one line that pushes, deletes the branch and re-points the upstream finishes the ship', () => {
    expect(classify(CHAIN)).toEqual(['fetch-ref', 'merge-base', 'push', 'delete', 'upstream'])
    let run = play(started(), 'git commit -m x')
    run = play(run, CHAIN, { isError: false, text: PUSHED })
    expect(run.pushed).toBe(true)
    expect(at(run)).toBe('7/done')
    expect(run.active).toBe(false)
  })

  test('that line does not finish the ship when the push never ran', () => {
    let run = play(started(), 'git commit -m x')
    run = play(run, CHAIN, { isError: false, text: 'To https://example.invalid/repo.git\n - [deleted]         claude/x' })
    expect(run.pushed).toBe(false)
    expect(at(run)).toBe('7/running')
    expect(at(pause(run))).toBe('7/waiting')
  })

  test('that line fails the ship when the push was refused', () => {
    let run = play(started(), 'git commit -m x')
    run = play(run, CHAIN, { isError: false, text: ' ! [rejected]        claude/x -> master (fetch first)\nerror: failed to push some refs' })
    expect(run.pushed).toBe(false)
    expect(run.phase).toBe('failed')
  })

  test('a push as the last command of a line is judged by its exit status', () => {
    const base = play(started(), 'git commit -m x')
    expect(play(base, 'git fetch origin master && git push origin x:master').pushed).toBe(true)
    const failed = play(base, 'git fetch origin master && git push origin x:master', { isError: true, text: '' })
    expect(failed.pushed).toBe(false)
    expect(failed.phase).toBe('failed')
  })

  test('a status or diff at the end of a longer line does not jump ahead', () => {
    expect(at(play(started(), 'git merge origin/master; git status --short'))).toBe('2/running')
    expect(at(play(started(), 'git add a.cs; git status --short'))).toBe('4/running')
  })

  test('a failed build is still seen when a status follows it on the same line', () => {
    const run = play(started(), 'dotnet build 2>&1 | tail -3; git status --short', { isError: false, text: 'Build FAILED.' })
    expect(at(run)).toBe('3/failed')
  })

  test('new work after a ship turns the check mark into a bolt', () => {
    let run = started()
    for (const command of ['git commit -m x', 'git push origin x:master']) run = play(run, command)
    run = pause(run)
    expect(at(run)).toBe('6/done')

    run = newWork(run)
    expect(at(run)).toBe('6/working')
    expect(run.active).toBe(false)
    expect(newWork(run)).toBe(run) // once is enough
    expect(play(run, 'git fetch')).toBe(run) // nothing is being shipped now
  })

  test('new work leaves a ship that is still under way alone', () => {
    const waiting = pause(play(started(), 'git fetch'))
    expect(newWork(waiting)).toBe(waiting)
    const failed = play(started(), 'dotnet build', { isError: true, text: '' })
    expect(newWork(failed)).toBe(failed)
    const never = idle()
    expect(newWork(never)).toBe(never)
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
    expect(titleFor('Add CSV export', { ...at3('working'), step: 7 })).toBe(`${BOLT} Add CSV export`)
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
    expect(statusFor({ ...at3('working'), step: 7, pushed: true })).toBe(`${BOLT} new work since the last ship-it`)
    expect(statusFor(fresh())).toBe(`${BOLT} new work`) // nothing has shipped yet
    expect(statusFor(started())).toBe(`${SHIP} ship-it Starting`)
  })

  test('bare takes the icons back off a title', () => {
    expect(bare(`${BUILD} Add CSV export`)).toBe('Add CSV export')
    expect(bare(`${HAND}${COMMIT} Add CSV export`)).toBe('Add CSV export')
    expect(bare(`${CHECK} Add CSV export`)).toBe('Add CSV export')
    expect(bare(`${BOLT} Add CSV export`)).toBe('Add CSV export')
    expect(bare(`${SHIP} ${BOLT} Add CSV export`)).toBe('Add CSV export') // icons stacked by two copies of the mod
    expect(bare('Plain title')).toBe('Plain title')
    expect(bare('Fix the 3/7 split')).toBe('Fix the 3/7 split')
  })

  test('the demo shows each icon and each moment that needs the person', () => {
    const titles = DEMO.map(run => titleFor('t', run))
    for (const icon of [SHIP, SYNC, MERGE, BUILD, STAGE, COMMIT, PUSH, CLEAN, CHECK, BOLT]) {
      expect(titles.some(title => title.includes(icon))).toBe(true)
    }
    for (const mark of [HAND, CROSS, SIGN]) expect(titles.some(title => title.includes(mark))).toBe(true)
  })
})

describe('a new session', () => {
  test('is marked in a worktree with worktree, anywhere with always, nowhere with never', () => {
    expect(marksNewSession('worktree', true)).toBe(true)
    expect(marksNewSession('worktree', false)).toBe(false)
    expect(marksNewSession('always', false)).toBe(true)
    expect(marksNewSession('never', true)).toBe(false)
  })

  test('starts under way, with the bolt and no ship behind it, and a ship-it takes over from there', () => {
    const run = fresh()
    expect(titleFor('t', run)).toBe(`${BOLT} t`)
    expect(parseRun(run)).toEqual(run)
    expect(newWork(run)).toBe(run)
    expect(pause(run)).toBe(run)
    expect(at(started())).toBe('0/running')
  })
})

describe('a refused title write', () => {
  test('is recognised when the app wants the person approval, in either wording', () => {
    const engine =
      "$.mcp.call(ccd_session_mgmt, set_session_title) refused: mcp__ccd_session_mgmt__set_session_title wasn't run: this call needs a person's approval, and a mod's own call can't ask for it."
    const app = "Could not rename this session: its title was set by the user, and replacing it needs their approval, which isn't available in this context."
    const stale = 'Could not rename this session: its title was set by the user and is not the one this call was approved to replace (it may have been renamed since).'
    expect(needsApproval(engine)).toBe(true)
    expect(needsApproval(app)).toBe(true)
    expect(needsApproval(stale)).toBe(true)
    expect(needsApproval('this call needs a person\u2019s approval')).toBe(true) // a typographic apostrophe
  })

  test('is not mistaken for an ordinary failure', () => {
    expect(needsApproval('declined')).toBe(false)
    expect(needsApproval('no answer from the app after 6s')).toBe(false)
    expect(needsApproval('the app refused the new title')).toBe(false)
    expect(needsApproval('')).toBe(false)
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
    const working: Run = { ...run, active: false, phase: 'working', pushed: true }
    expect(parseRun(working)).toEqual(working)
    expect(parseRun({ ...run, step: 99 })).toBeUndefined()
    expect(parseRun({ ...run, phase: 'sparkle' })).toBeUndefined()
    expect(parseRun({ ...run, active: 'yes' })).toBeUndefined()
    expect(parseRun(undefined)).toBeUndefined()
  })

  test('the choice not to follow the work is kept with the marking', () => {
    const off = following({ isOn: true, base: 'a' }, false)
    expect(off).toEqual({ isOn: true, base: 'a', isTopicOff: true })
    expect(marked(off, true, 'b')).toEqual({ isOn: true, base: 'b', isTopicOff: true })
    expect(marked(off, false, 'b')).toEqual({ isOn: false, base: 'b', isTopicOff: true })
    expect(following(off, true)).toEqual({ isOn: true, base: 'a' })
    expect(marked(undefined, true, 'b')).toEqual({ isOn: true, base: 'b' })
    expect(parseCfg(off)).toEqual(off)
    expect(parseCfg({ isOn: true, base: 'a', isTopicOff: 'yes' })).toEqual({ isOn: true, base: 'a' })
  })
})

describe('the words of the title', () => {
  const QUOTE_OPEN = String.fromCodePoint(0x201c)
  const QUOTE_CLOSE = String.fromCodePoint(0x201d)
  const ROCKET = String.fromCodePoint(0x1f680)
  const ELLIPSIS = String.fromCodePoint(0x2026)

  test('tidy drops the harness notes and runs of white space', () => {
    expect(tidy('Fix the build\n\n  please <system-reminder>today is a day</system-reminder>')).toBe('Fix the build please')
    expect(tidy('<command-name>/x</command-name> hello')).toBe('hello')
  })

  test('a prompt is worth checking when it is more than a word and no slash command', () => {
    expect(worthChecking('Look at the invoice PDF layout', 8)).toBe(true)
    expect(worthChecking('yes', 8)).toBe(false)
    expect(worthChecking('  do it  ', 8)).toBe(false)
    expect(worthChecking('/ship-status topic now', 8)).toBe(false)
    expect(worthChecking('<system-reminder>a note</system-reminder>', 8)).toBe(false)
  })

  test('what was said ends with the new prompt, once, without empty rows or slash commands', () => {
    const history = [
      { role: 'user', text: 'Add CSV export' },
      { role: 'assistant', text: '' }, // only tool calls
      { role: 'user', text: '/ship-status' },
      { role: 'assistant', text: 'Done.' },
      { role: 'user', text: 'Now the invoice PDF <system-reminder>a note</system-reminder>' },
    ]
    expect(recent(history, 'Now the invoice PDF', 6, 100)).toEqual([
      { role: 'user', text: 'Add CSV export' },
      { role: 'assistant', text: 'Done.' },
      { role: 'user', text: 'Now the invoice PDF' },
    ])
  })

  test('only the newest lines are kept, and a long one is shortened', () => {
    const history = Array.from({ length: 10 }, (_, at) => ({ role: at % 2 === 0 ? 'user' : 'assistant', text: `message ${at}` }))
    expect(recent(history, '', 3, 100).map(line => line.text)).toEqual(['message 7', 'message 8', 'message 9'])
    expect(recent([], 'x'.repeat(50), 6, 10)).toEqual([{ role: 'user', text: `${'x'.repeat(9)}${ELLIPSIS}` }])
  })

  test('the question names the title and what was said, and the rules name the limit', () => {
    const prompt = topicPrompt('Add CSV export', [{ role: 'user', text: 'hello there' }])
    expect(prompt).toContain('Current title: Add CSV export')
    expect(prompt).toContain('[user] hello there')
    expect(topicPrompt('', [])).toContain('Current title: (none)')
    expect(topicRules(32)).toContain('at most 32 characters')
  })

  test('the answer is read for its new title', () => {
    const read = (reply: string): string | undefined => parseTopic(reply, 'Add CSV export', 40)
    expect(read('SAME')).toBeUndefined()
    expect(read('NEW: Invoice PDF page breaks')).toBe('Invoice PDF page breaks')
    expect(read('new - Invoice PDF page breaks.')).toBe('Invoice PDF page breaks')
    expect(read(`NEW: ${QUOTE_OPEN}Invoice PDF page breaks${QUOTE_CLOSE}`)).toBe('Invoice PDF page breaks')
    expect(read('Sure!\nNEW: Invoice PDF page breaks')).toBe('Invoice PDF page breaks') // a line of its own
    expect(read('NEW: **Title:** Login rate limits')).toBe('Login rate limits') // markdown and a label
    expect(read('NEW: add csv export.')).toBeUndefined() // the same words
    expect(read('NEW:')).toBeUndefined()
    expect(read('NEW: ok')).toBeUndefined() // too short to mean anything
    expect(read('Something else entirely')).toBeUndefined()
    expect(read('Newest request is about invoices')).toBeUndefined()
  })

  test('a title loses its pictures, is cut at a word, and stays on one line', () => {
    expect(cleanTopic(`${ROCKET} Ship the release`, 40)).toBe('Ship the release')
    expect(cleanTopic('Invoice\nPDF   layout', 40)).toBe('Invoice PDF layout')
    expect(cleanTopic('Invoice PDF page breaks for the very long monthly statement', 30)).toBe('Invoice PDF page breaks for')
    expect(cleanTopic('x'.repeat(60), 40)).toBe('x'.repeat(40))
  })

  test('two titles are the same when their words are', () => {
    expect(sameWords('Add CSV export!', 'add  csv export')).toBe(true)
    expect(sameWords('Add CSV export', 'Add PDF export')).toBe(false)
  })
})
