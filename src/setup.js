// `dockferret setup`: wires the install hook, the MCP connector and a one-line instruction into each agent found.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'

const SRC = dirname(new URL(import.meta.url).pathname)
const MARK = '.dockferret/runtime/hook.js'
const LINE = 'Before installing or recommending any skill, plugin, MCP server or package, check it with dockferret first.'
const BLOCK = `\n<!-- dockferret -->\n${LINE}\n<!-- /dockferret -->\n`

const has = cmd => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true } catch { return false } }
// Agent CLIs keep their config under HOME, so they act on the same home folder as the files we edit.
const run = (cmd, args, home) => { try { execFileSync(cmd, args, { stdio: 'ignore', env: { ...process.env, HOME: home } }); return true } catch { return false } }
const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback } }

function backup(p) {
  if (existsSync(p) && !existsSync(`${p}.dockferret-backup`)) copyFileSync(p, `${p}.dockferret-backup`)
}
function writeJson(p, data) {
  backup(p); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`)
}
function editText(p, fn) {
  const before = existsSync(p) ? readFileSync(p, 'utf8') : ''
  const after = fn(before.replace(BLOCK, '').replace(/\n<!-- dockferret -->[\s\S]*?<!-- \/dockferret -->\n/, ''))
  if (after === before) return
  backup(p); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, after)
}

// Claude Code and Codex share this hooks shape; ours is recognised by the runtime path in its command.
export function withHook(settings, event, entry) {
  const hooks = { ...settings.hooks }
  hooks[event] = (hooks[event] ?? []).filter(g => !JSON.stringify(g).includes(MARK))
  if (entry) hooks[event].push(entry)
  if (!hooks[event].length) delete hooks[event]
  return { ...settings, hooks }
}

export function agents(home, version) {
  const runtime = join(home, '.dockferret', 'runtime')
  const hookCmd = agent => `"${process.execPath}" "${join(runtime, 'hook.js')}" ${agent}`
  const mcpArgs = ['-y', `dockferret@${version}`, 'mcp']
  const guiEnv = { PATH: `${dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin` } // GUI apps lack the shell PATH
  const shellHook = (agent, extra = {}) => ({ matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd(agent), timeout: 120, ...extra }] })

  return [
    {
      name: 'Claude Code',
      found: has('claude') || existsSync(join(home, '.claude')),
      changes: ['~/.claude/settings.json: PreToolUse hook on shell commands', 'MCP server "dockferret" (user scope)', '~/.claude/CLAUDE.md: one instruction line'],
      install() {
        const p = join(home, '.claude', 'settings.json')
        writeJson(p, withHook(readJson(p, {}), 'PreToolUse', shellHook('claude')))
        run('claude', ['mcp', 'remove', '--scope', 'user', 'dockferret'], home)
        run('claude', ['mcp', 'add', '--scope', 'user', 'dockferret', '--', 'npx', ...mcpArgs], home)
        editText(join(home, '.claude', 'CLAUDE.md'), t => t + BLOCK)
      },
      uninstall() {
        const p = join(home, '.claude', 'settings.json')
        if (existsSync(p)) writeJson(p, withHook(readJson(p, {}), 'PreToolUse', null))
        run('claude', ['mcp', 'remove', '--scope', 'user', 'dockferret'], home)
        editText(join(home, '.claude', 'CLAUDE.md'), t => t)
      },
    },
    {
      name: 'Codex',
      found: has('codex') || existsSync(join(home, '.codex')),
      changes: ['~/.codex/hooks.json: PreToolUse hook on shell commands (approve it once with /hooks)', 'MCP server "dockferret"', '~/.codex/AGENTS.md: one instruction line'],
      install() {
        const p = join(home, '.codex', 'hooks.json')
        writeJson(p, withHook(readJson(p, {}), 'PreToolUse', shellHook('codex', { statusMessage: 'DockFerret: checking install' })))
        run('codex', ['mcp', 'remove', 'dockferret'], home)
        run('codex', ['mcp', 'add', 'dockferret', '--', 'npx', ...mcpArgs], home)
        editText(join(home, '.codex', 'AGENTS.md'), t => t + BLOCK)
      },
      uninstall() {
        const p = join(home, '.codex', 'hooks.json')
        if (existsSync(p)) writeJson(p, withHook(readJson(p, {}), 'PreToolUse', null))
        run('codex', ['mcp', 'remove', 'dockferret'], home)
        editText(join(home, '.codex', 'AGENTS.md'), t => t)
      },
    },
    {
      name: 'Cursor',
      found: existsSync(join(home, '.cursor')),
      changes: ['~/.cursor/hooks.json: beforeShellExecution hook', '~/.cursor/mcp.json: MCP server "dockferret"'],
      install() {
        const h = join(home, '.cursor', 'hooks.json')
        const cfg = readJson(h, { version: 1, hooks: {} })
        const list = (cfg.hooks?.beforeShellExecution ?? []).filter(x => !String(x.command).includes(MARK))
        writeJson(h, { version: 1, ...cfg, hooks: { ...cfg.hooks, beforeShellExecution: [...list, { command: hookCmd('cursor') }] } })
        const m = join(home, '.cursor', 'mcp.json')
        const mcp = readJson(m, {})
        writeJson(m, { ...mcp, mcpServers: { ...mcp.mcpServers, dockferret: { command: 'npx', args: mcpArgs, env: guiEnv } } })
      },
      uninstall() {
        const h = join(home, '.cursor', 'hooks.json')
        if (existsSync(h)) {
          const cfg = readJson(h, { version: 1, hooks: {} })
          cfg.hooks.beforeShellExecution = (cfg.hooks?.beforeShellExecution ?? []).filter(x => !String(x.command).includes(MARK))
          writeJson(h, cfg)
        }
        const m = join(home, '.cursor', 'mcp.json')
        if (existsSync(m)) { const mcp = readJson(m, {}); delete mcp.mcpServers?.dockferret; writeJson(m, mcp) }
      },
    },
    {
      name: 'Gemini CLI',
      found: has('gemini'),
      changes: ['a "dockferret" extension: BeforeTool hook on shell commands, MCP server, one instruction line'],
      install() {
        const ext = join(home, '.dockferret', 'gemini-extension')
        mkdirSync(join(ext, 'hooks'), { recursive: true })
        writeFileSync(join(ext, 'gemini-extension.json'), JSON.stringify({
          name: 'dockferret', version, contextFileName: 'GEMINI.md',
          mcpServers: { dockferret: { command: 'npx', args: mcpArgs, env: guiEnv } },
        }, null, 2))
        writeFileSync(join(ext, 'hooks', 'hooks.json'), JSON.stringify({
          hooks: { BeforeTool: [{ matcher: 'run_shell_command', hooks: [{ name: 'dockferret', type: 'command', command: hookCmd('gemini') }] }] },
        }, null, 2))
        writeFileSync(join(ext, 'GEMINI.md'), `${LINE}\n`)
        run('gemini', ['extensions', 'uninstall', 'dockferret'], home)
        execFileSync('gemini', ['extensions', 'install', ext], { stdio: 'inherit', env: { ...process.env, HOME: home } })
      },
      uninstall() { run('gemini', ['extensions', 'uninstall', 'dockferret'], home) },
    },
  ]
}

export function installRuntime(home) {
  const runtime = join(home, '.dockferret', 'runtime')
  mkdirSync(runtime, { recursive: true })
  for (const f of ['hook.js', 'scan.js']) copyFileSync(join(SRC, f), join(runtime, f))
  writeFileSync(join(runtime, 'package.json'), '{ "type": "module" }\n')
}

export async function setup({ version, yes = false, uninstall = false, home = homedir() }) {
  const found = agents(home, version).filter(a => a.found)
  if (!found.length) {
    console.log('No supported agents found (Claude Code, Codex, Cursor, Gemini CLI). For any other MCP client, add a server with command `npx` and args `-y dockferret mcp`.')
    return
  }
  console.log(uninstall ? 'DockFerret will be removed from:\n' : 'DockFerret will set up:\n')
  for (const a of found) {
    console.log(`  ${a.name}`)
    if (!uninstall) for (const c of a.changes) console.log(`    · ${c}`)
  }
  console.log(uninstall ? '' : '\nEvery file is backed up as <file>.dockferret-backup before its first change. Undo with: dockferret setup --uninstall\n')

  if (!yes) {
    if (!process.stdin.isTTY) { console.log('Run in a terminal to confirm, or add --yes.'); return }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(uninstall ? 'Remove? [y/N] ' : 'Go ahead? [y/N] ')
    rl.close()
    if (!/^y(es)?$/i.test(answer.trim())) { console.log('Nothing changed.'); return }
  }

  if (!uninstall) installRuntime(home)
  for (const a of found) {
    try {
      uninstall ? a.uninstall() : a.install()
      console.log(`✓ ${a.name}`)
    } catch (e) {
      console.log(`✗ ${a.name}: ${e.message.split('\n')[0]}`)
    }
  }
  if (uninstall) rmSync(join(home, '.dockferret', 'runtime'), { recursive: true, force: true })
  else if (found.some(a => a.name === 'Codex')) console.log('\nCodex: open Codex and run /hooks once to approve the DockFerret hook.')
  console.log(uninstall ? '\nDone.' : '\nDone. Restart any agent that is already open.')
}
