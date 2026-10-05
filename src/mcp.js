// MCP connector: lets Codex, Claude, Cursor or any MCP client ask "should I install this?"
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { formatRun, runSandboxed } from './sandbox.js'
import { formatReport, resolveTarget, scanDir } from './scan.js'

const text = t => ({ content: [{ type: 'text', text: t }] })
const fail = e => ({ content: [{ type: 'text', text: `dockferret failed: ${e.message}` }], isError: true })

export async function serve(version) {
  const server = new McpServer({ name: 'dockferret', version })

  server.registerTool('check', {
    title: 'Check a tool before installing it',
    description:
      'Static safety and fit report for an agent skill, plugin, MCP server or npm package: what it can do (run commands, ' +
      'reach the network, read credentials, keep running in the background, call AI models) with file:line evidence. ' +
      'Use it before installing anything. Target: a local folder, a GitHub URL, or an npm package name.',
    inputSchema: { target: z.string().describe('Local path, https://github.com/owner/repo[/tree/branch/sub/dir], or npm package name') },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ target }) => {
    try {
      const { dir, source, cleanup } = resolveTarget(target)
      try { return text(formatReport(target, source, scanDir(dir))) } finally { cleanup() }
    } catch (e) { return fail(e) }
  })

  server.registerTool('run', {
    title: 'Run a tool in a sandbox',
    description:
      'Runs a command against a throwaway copy of the target in a macOS sandbox: no network (unless allowed), no access to ' +
      'your home folder or secrets, writes confined to the sandbox. Reports blocked network and file access, files ' +
      'created, and processes left running. Example command: "npm install" or "python scripts/setup.py".',
    inputSchema: {
      target: z.string().describe('Local path, GitHub URL, or npm package name'),
      command: z.string().describe('Shell command to run inside the copy'),
      allowNetwork: z.boolean().optional().describe('Allow network access (default false)'),
      timeoutSeconds: z.number().int().min(1).max(600).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ target, command, allowNetwork = false, timeoutSeconds = 60 }) => {
    try {
      const { dir, cleanup } = resolveTarget(target)
      try {
        return text(formatRun(await runSandboxed(dir, command, { network: allowNetwork, timeoutMs: timeoutSeconds * 1000 })))
      } finally { cleanup() }
    } catch (e) { return fail(e) }
  })

  await server.connect(new StdioServerTransport())
}
