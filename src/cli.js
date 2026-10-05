#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { formatRun, runSandboxed } from './sandbox.js'
import { formatReport, resolveTarget, scanDir } from './scan.js'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const HELP = `dockferret ${version}: try it in a sandbox before it touches your machine

  dockferret check <target> [--json]           What it can do, with file:line evidence
  dockferret run <target> [--net] [--timeout s] -- <command>
                                             Run a command against a sandboxed copy
  dockferret mcp                               Start the MCP connector (stdio)

  <target> is a local folder, a GitHub URL, or an npm package name.

  Add to your agent:
    codex mcp add dockferret -- npx -y dockferret mcp
    claude mcp add dockferret -- npx -y dockferret mcp`

const dash = process.argv.indexOf('--')
const argv = process.argv.slice(2, dash === -1 ? undefined : dash)
const command = dash === -1 ? '' : process.argv.slice(dash + 1).join(' ')
const { values, positionals } = parseArgs({
  args: argv, allowPositionals: true,
  options: { json: { type: 'boolean' }, net: { type: 'boolean' }, timeout: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } },
})
const [cmd, target] = positionals

try {
  if (values.version) console.log(version)
  else if (cmd === 'mcp') await (await import('./mcp.js')).serve(version)
  else if (cmd === 'check' && target) {
    const { dir, source, cleanup } = resolveTarget(target)
    try {
      const r = scanDir(dir)
      console.log(values.json ? JSON.stringify({ target, source, ...r }, null, 2) : formatReport(target, source, r))
      process.exitCode = r.verdict === 'review first' ? 2 : 0
    } finally { cleanup() }
  } else if (cmd === 'run' && target && command) {
    const { dir, cleanup } = resolveTarget(target)
    try {
      const r = await runSandboxed(dir, command, { network: values.net, timeoutMs: Number(values.timeout ?? 60) * 1000 })
      console.log(values.json ? JSON.stringify(r, null, 2) : formatRun(r))
    } finally { cleanup() }
  } else {
    console.log(HELP)
    process.exitCode = values.help ? 0 : 1
  }
} catch (e) {
  console.error(`dockferret: ${e.message}`)
  process.exitCode = 1
}
