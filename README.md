# ship-status

A Claude Code mod for the desktop app's sidebar. It shows how far `/ship-it` has got as an icon in front
of the session's title, and it keeps the words of the title true to what the session is working on, so
sessions can still be told apart after they turn to something else.

The first `/ship-it` in a session puts the icon on (no question is asked). From then on it changes at
every step:

| Step of `ship-it.md`         | Icon |
| ---------------------------- | ---- |
| just started                 | 🚢   |
| 1 Sync with remote           | 🔄   |
| 2 Merge master into branch   | 🔀   |
| 3 Build                      | 🔨   |
| 4 Review and stage           | 📋   |
| 5 Commit                     | 📝   |
| 6 Merge the branch to master | 🚀   |
| 7 Clean up                   | 🧹   |
| shipped                      | ✅   |
| new work since the last ship | ⚡   |

Moments that need you get a mark in front of the step icon: ✋ waiting for you (a confirmation),
❌ a command failed (a failed build, a rejected push), 🚧 merge conflicts. A toast also appears for
the last two. The same text is pinned as a status line under the prompt.

A title reads `✋📝 Add CSV export`. The title is read again at the start of every run, so renaming
the session by hand between runs is fine: the icon goes in front of the new name.

Once a ship has finished, the ✅ stays only until your next prompt. Then it becomes ⚡ to say new work
is under way, and it stays that way until the next `/ship-it`. A slash command that starts no turn
(such as `/ship-status`) does not count. If you would rather have a plain title than a bolt, set
`working` to `''` in `PHASE_ICON` (`hooks/steps.ts`).

A new session gets the bolt without a ship-it: a few seconds after its first prompt, once the app has
named the session, ⚡ goes in front of the name, and the first `/ship-it` carries on from there. Nobody
has to type it in, which matters: a title typed by hand counts as the person's, and the desktop app then
asks for the person's approval before ship-status may change it (see "If it looks wrong"). A session
with a history (a resume, an older one) waits for the first `/ship-it`. `NEW_SESSION_MARK` in
`hooks/register.ts` changes that: `'worktree'` marks only new sessions in a git worktree, `'never'` none.

## The words follow the work

A session often turns to something else, and a sidebar of titles that all open with ⚡ and name the
first task does not help. So once a session is marked, the words after the icon follow the work.

At each prompt you type, a small model (Haiku) reads the title as it stands, the last few messages and
your new prompt, and answers on one line: the work is the same, or it has moved to a different task and
here is its title. A follow-up, a question, a fix, a commit or a push of the same work is the same task.
A new title is a short noun phrase of at most 40 characters with its most distinctive words first, so it
still tells sessions apart when the sidebar clips it. The icon stays in front, and the next `/ship-it`
carries on from the new words: `⚡ Invoice PDF page breaks`, then `🔨 Invoice PDF page breaks`.

- Nothing waits for the answer: the prompt goes on its way, and the title changes a moment later.
- Slash commands, very short answers ("yes", "do it") and prompts you did not type are not asked about,
  and nothing is asked while a `/ship-it` is under way.
- A check is one small request through the session's own client and credentials, counted in `/cost`
  like any other. The model reads the title, your new prompt and the last few messages, each cut to 300
  characters. It needs a build of Claude Code that has `$.model` (2.1.321 and newer do). On one that
  does not, or when the model never answers, the checks give up after three tries and the rest keeps
  working.
- `/ship-status topic off` keeps the words of one session as they are. `TOPIC_TITLES` in
  `hooks/register.ts` turns the checks off for every session.
- If you do not like a title, `/ship-status rename <words>` sets it. The icon stays in front, the next
  `/ship-it` carries on from your words, and the checks leave them alone until `/ship-status topic on`.
  The mod writes the title, so it stays one the mod may keep changing. Typing a title into the sidebar
  yourself would lock it (see "If it looks wrong").
- A title you typed by hand is yours: the app asks for your approval before the mod may replace it, and a
  mod cannot ask. ship-status then says so once and stops (see "If it looks wrong").

## Install

Needs Claude Code 2.1.304 or newer (older builds do not know function-hook mods).

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**,
**Add marketplace** with `Gnarnaw2/Claude_Shipit_Status`, then **Add plugin** and pick `ship-status`.

At the prompt of a terminal session:

```
/plugin install ship-status --marketplace Gnarnaw2/Claude_Shipit_Status
```

From a shell:

```
claude plugin install ship-status --marketplace Gnarnaw2/Claude_Shipit_Status
```

## How it knows the step

`ship-it.md` is instructions for the model, so the mod watches what the model runs: Bash and
PowerShell commands are matched to steps (`git fetch`/`pull` is 1, `git merge` is 2, a build tool is 3,
`git add` is 4, `git commit` is 5, `git push origin <branch>:master` is 6, `git push --delete` is 7). A
step never goes backwards once the commit is made, a failed `git push --delete` does not undo a ship,
and the run is shipped once the push to master succeeds (a line that chains the push, the branch delete and the upstream re-point is read as a whole, including what the push printed). Nothing is added to the model's prompt and the
mod never runs git itself.

The title is changed through the desktop app's own `set_session_title` tool. In a plain terminal there
is no sidebar, so only the status line is used.

## `/ship-status`

| Command                                                      | Does                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `/ship-status`                                               | shows how this session is marked, where ship-it stands and what the last title check said |
| `/ship-status demo`                                          | previews every step on the title for about 20 s, then restores it |
| `/ship-status off`                                           | takes the icon off and leaves the title alone (its words stay)    |
| `/ship-status on`                                            | marks the title again, and tries a title the app refused again    |
| `/ship-status topic`                                         | says whether the words follow the work, and what the last check came to |
| `/ship-status topic on\|off`                                  | makes the words of this session follow the work, or stay as they are |
| `/ship-status topic now`                                     | checks this moment, and tries again after the checks gave up      |
| `/ship-status rename <words>`                                | sets the words of the title by hand, and keeps the checks away from them |
| `/ship-status step <0-7\|wait\|fail\|conflict\|done\|work\|idle>` | sets the display by hand if it ever gets out of step         |
| `/ship-status log`                                           | lists what the mod did lately, for when something looks wrong     |

## If it looks wrong

- `/ship-status` shows whether the title can be changed, and the last problem the app reported.
- `/ship-status log` lists what the mod did lately: the titles it set and anything the app refused.
- The app sometimes resets a session's title: when the session is resumed, and now and then as a turn
  ends. A moment after each turn the mod reads the title again and puts its icon back, or keeps a new
  name if you or the app gave the session one. Right after a resume it writes nothing until your first
  prompt.
- A title write that fails, or gets no answer from the app, no longer silences the mod for the rest of
  the session: the next `/ship-it` starts from a clean slate.
- The desktop app asks the person before it replaces a title the person set, and an icon typed in by
  hand counts as the person's. A mod cannot ask, so the app (or Claude Code in front of it) refuses the
  write. ship-status then says so once, stops writing until the next `/ship-it`, and keeps the status
  line going. To let it carry on, ask Claude to rename the session to the title the message names,
  approve the app's prompt, and run `/ship-status on`: a title Claude renamed with the person's
  approval is no longer counted as theirs, so ship-status can change it from then on. A write the mod
  makes of its own accord (the bolt on a new session, putting an icon back) that the app refuses for
  this reason is noted in `/ship-status log` and shown by `/ship-status`, but not announced. A new
  title from a check that the app refuses is announced once, since the words then cannot follow the work.
- You never need `/ship-status on` before `/ship-it`. It is only for turning marking back on after
  `/ship-status off`.
- A plugin installed from a marketplace does not update by itself, and `/reload-plugins` only re-reads
  the installed copy. To get a new version, update the marketplace and the plugin from the app's Plugins
  menu (or `claude plugin marketplace update` then `claude plugin update ship-status`), then run
  `/reload-plugins`.

## Customising

- A build the mod does not recognise (`dotnet`, `npm run build`, `msbuild`, `make`, `gradle`, `mvn`,
  `cargo build`, `go build`, `build*.ps1/.cmd/.sh` and a few more are): add a pattern to `BUILD_HINTS`
  in `hooks/steps.ts`.
- Icons and step names: `STEPS` and `PHASE_ICON` in `hooks/steps.ts`.
- Which new sessions get the bolt before any ship-it, and how long the app is given to name them:
  `NEW_SESSION_MARK` and `NEW_SESSION_DELAY_MS` in `hooks/register.ts`.
- The title check: `TOPIC_TITLES` (on or off), `TOPIC_MODEL`, `TOPIC_MAX_CHARS` (the longest new title),
  `TOPIC_MIN_PROMPT_CHARS`, `TOPIC_LINES` and `TOPIC_LINE_CHARS` (how much of the conversation the model
  reads), and the rules it is given, `topicRules` in `hooks/steps.ts`.
- Another skill or command name than `ship-it`: the matcher on `skill.prompt` in `hooks/register.ts`.

## Checks

```
claude plugin validate .
claude plugin test .
```

## License

[The Unlicense](LICENSE): public domain, no conditions and no warranty.
