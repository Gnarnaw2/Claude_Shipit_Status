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

Moments that need you get a mark in front of the step icon: ✋ waiting for you (a confirmation),
❌ a command failed (a failed build, a rejected push), 🚧 merge conflicts. A toast also appears for
the last two. The same text is pinned as a status line under the prompt.

A title reads `✋📝 Add CSV export`. The title is read again at the start of every run, so renaming
the session by hand between runs is fine: the icon goes in front of the new name.

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

While the repository is private it installs only for people who can read it on GitHub and whose machine
already holds a git credential for github.com (an SSH key, or `gh auth login` then `gh auth setup-git`):
the install never prompts for one.

## How it knows the step

`ship-it.md` is instructions for the model, so the mod watches what the model runs: Bash and
PowerShell commands are matched to steps (`git fetch`/`pull` is 1, `git merge` is 2, a build tool is 3,
`git add` is 4, `git commit` is 5, `git push origin <branch>:master` is 6, `git push --delete` is 7). A
step never goes backwards once the commit is made, a failed `git push --delete` does not undo a ship,
and the run is shipped once the push to master succeeds. Nothing is added to the model's prompt and the
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
| `/ship-status step <0-7\|wait\|fail\|conflict\|done\|idle>`  | sets the display by hand if it ever gets out of step              |

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
