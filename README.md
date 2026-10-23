# ship-status

A Claude Code mod that shows how far `/ship-it` has got on a worktree, as an icon in front of the
session's title in the desktop app's sidebar.

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
| `/ship-status`                                               | shows whether this worktree is marked and where ship-it stands    |
| `/ship-status demo`                                          | previews every step on the title for about 20 s, then restores it |
| `/ship-status off`                                           | puts the original title back and leaves the title alone           |
| `/ship-status on`                                            | marks the title again                                             |
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
- Another skill or command name than `ship-it`: the matcher on `skill.prompt` in `hooks/register.ts`.

## Checks

```
claude plugin validate .
claude plugin test .
```

## License

[The Unlicense](LICENSE): public domain, no conditions and no warranty.
