# dockferret

Try any agent skill, plugin, MCP server or npm package in a sandbox before it touches your machine.

Thousands of skills, plugins and MCP servers are appearing for Claude Code, Codex, Cursor, Gemini CLI and every other coding agent. Most of them are fine. Some run code on install, keep running after you close everything, read your keys, or quietly spend your tokens. `dockferret` tells you which before you install.

```
$ npx dockferret check https://github.com/someone/cool-skill

dockferret · cool-skill  (skill · github.com/someone/cool-skill · 14 files)
Verdict: review first

● high   pipes a download straight into a shell
           SKILL.md:22
◐ medium keeps running in the background
           scripts/start.sh:4
○ info   calls an AI model (costs tokens)
           scripts/summarise.py:31
```

## Commands

```
dockferret check <target> [--json]                         static report, with file:line evidence
dockferret run <target> [--net] [--timeout s] -- <command>  run it against a sandboxed copy
dockferret mcp                                             MCP connector for any agent
```

`<target>` is a local folder, a GitHub URL (`https://github.com/owner/repo/tree/main/sub/dir` works), or an npm package name. npm packages are downloaded with install scripts disabled, so checking never runs the thing being checked.

`check` exits with code 2 when the verdict is "review first", so you can use it in scripts and CI.

## Use it from your agent

Add the connector, then ask your agent "should I install this?":

```
codex mcp add dockferret -- npx -y dockferret mcp
claude mcp add dockferret -- npx -y dockferret mcp
```

For Cursor and other MCP clients, add a server with command `npx` and args `["-y", "dockferret", "mcp"]`. It exposes two tools, `check` and `run`. Your own agent reads the report and judges fit against what you're working on, so there's no extra model bill.

## What the sandbox does

`dockferret run` copies the target to a temporary folder and runs your command under macOS `sandbox-exec`:

- **No network**, including DNS, unless you pass `--net`.
- **No reading your home folder** (keys, browser profiles, other projects). Language runtimes such as `~/.nvm` stay readable.
- **Writes only inside the sandbox.** `HOME` and `TMPDIR` point at empty folders in it.
- **None of your environment variables** except `PATH` and `LANG`, so API keys in your shell never reach the tool.
- **Processes left running** after the command exits are reported, then stopped.

The report lists blocked network and file access, files created or changed, and the last lines of output.

## What it checks

Install scripts · piping downloads into a shell · disabling safety flags · hidden or encoded code · prompt instructions that try to override yours · credential and key access · `rm -rf` · `sudo` · background persistence (`nohup`, `screen -d`, `caffeinate`, `launchctl`, `crontab`) · running commands · network calls · secrets in environment variables · browser automation · writes to your home folder · AI model calls.

It recognises Agent Skills (`SKILL.md`, read by 27+ agents), Claude Code plugins and mods, Codex plugins, MCP servers (Node and Python) and npm packages.

## Limits

- `check` reads source. It sees what code and instructions *mention*, so a tool that watches for `caffeinate` looks the same as one that runs it. Confirm with `run`.
- The sandbox runs on macOS only for now. Linux (bubblewrap) and Docker are next.
- It is a second opinion, not a guarantee. Read the evidence lines.

## License

MIT
