#!/usr/bin/env node
// One pre-command hook for every agent: spots install commands, checks the target, answers in that agent's format.
// Stdlib only (via scan.js), so it runs from a plain copy with no node_modules.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveTarget, scanDir } from './scan.js'

const SKILL_DIR = /(^|\/)(\.?claude|\.?codex|\.?cursor|\.?gemini|\.agents?)\/(skills|plugins|extensions)(\/|$)|(^|\/)skills(\/|$)/
const OK_PREFIX = /(^|\s)DOCKFERRET_OK=1\s/

// Pulls what an install command would bring in. Heuristic on purpose: unknown shapes pass through unchecked.
export function installTargets(command) {
  const targets = []
  for (const part of command.split(/&&|\|\||;|\n/)) {
    const w = part.trim().split(/\s+/).filter(Boolean).filter(x => !/^[A-Z_]+=/.test(x))
    const args = (from) => w.slice(from).filter(x => !x.startsWith('-'))
    const npmLike = /^(npm|pnpm|yarn|bun)$/.test(w[0])
    if (npmLike && /^(i|install|add)$/.test(w[1])) targets.push(...args(2).filter(x => !/^\.{0,2}\//.test(x)))
    else if ((w[0] === 'npx' || w[0] === 'bunx') && w.includes('skills') && w.includes('add')) {
      const t = args(w.indexOf('add') + 1)[0]
      if (t) targets.push(/^[\w.-]+\/[\w.-]+$/.test(t) ? `github.com/${t}` : t)
    } else if ((w[0] === 'claude' || w[0] === 'codex') && w[1] === 'mcp' && w[2] === 'add') {
      const npx = w.findIndex(x => x === 'npx' || x === 'bunx')
      if (npx !== -1) { const pkg = args(npx + 1)[0]; if (pkg) targets.push(pkg) }
    } else if (w[0] === 'claude' && w[1] === 'plugin' && /^(install|i)$/.test(w[2])) {
      const p = args(3)[0]
      if (p?.endsWith('@npm')) targets.push(p.slice(0, -4))
    } else if (w[0] === 'git' && w[1] === 'clone') {
      const [url, dest = ''] = args(2)
      if (url && (SKILL_DIR.test(dest) || SKILL_DIR.test(url))) targets.push(url)
    }
  }
  // dockferret checking itself would be a loop of no value
  return [...new Set(targets)].filter(t => !/^dockferret(@|$)/.test(t))
}

const CACHE = join(process.env.DOCKFERRET_HOME ?? join(homedir(), '.dockferret'), 'cache.json')
const DAY = 86_400_000

function check(target) {
  let cache = {}
  try { cache = JSON.parse(readFileSync(CACHE, 'utf8')) } catch {}
  const hit = cache[target]
  if (hit && Date.now() - hit.at < DAY) return hit.r
  const { dir, cleanup } = resolveTarget(target)
  try {
    const { verdict, findings } = scanDir(dir)
    const r = { verdict, findings: findings.filter(f => f.severity !== 'info').map(f => `${f.what} (${f.where[0]})`) }
    cache[target] = { at: Date.now(), r }
    try { mkdirSync(join(CACHE, '..'), { recursive: true }); writeFileSync(CACHE, JSON.stringify(cache)) } catch {}
    return r
  } finally { cleanup() }
}

const RANK = { 'low risk': 0, 'check before installing': 1, 'review first': 2 }

export function decide(command) {
  if (OK_PREFIX.test(` ${command}`)) return { level: 0, text: '' }
  const targets = installTargets(command)
  if (!targets.length) return null
  let level = 0
  const lines = []
  for (const t of targets) {
    try {
      const r = check(t)
      level = Math.max(level, RANK[r.verdict])
      lines.push(`${t}: ${r.verdict}${r.findings.length ? ` — ${r.findings.slice(0, 4).join('; ')}` : ''}`)
    } catch (e) {
      lines.push(`${t}: could not be checked (${e.message.split('\n')[0].slice(0, 100)})`)
    }
  }
  return { level, text: `DockFerret checked this install. ${lines.join(' | ')}` }
}

// Each agent's own answer format (see its hooks docs). Level 2 stops the command; level 1 lets it run with a note.
export function respond(agent, d) {
  const override = 'If the user has seen these findings and still wants it, re-run the same command prefixed with DOCKFERRET_OK=1.'
  if (agent === 'cursor') {
    if (d.level === 2) return { permission: 'ask', user_message: d.text, agent_message: d.text }
    return { permission: 'allow', ...(d.level ? { agent_message: d.text } : {}) }
  }
  if (agent === 'gemini') {
    if (d.level === 2) return { decision: 'deny', reason: `${d.text}. ${override}`, systemMessage: d.text }
    return { decision: 'allow', ...(d.level ? { systemMessage: d.text } : {}) }
  }
  const out = { hookEventName: 'PreToolUse' }
  if (agent === 'codex') {
    // Codex parses "ask" but does not support it yet, so a risky install is denied with a way through.
    if (d.level < 2) return d.level ? { systemMessage: d.text } : {}
    return { hookSpecificOutput: { ...out, permissionDecision: 'deny', permissionDecisionReason: `${d.text}. ${override}` } }
  }
  // claude
  if (d.level === 2) return { hookSpecificOutput: { ...out, permissionDecision: 'ask', permissionDecisionReason: d.text } }
  return d.level ? { hookSpecificOutput: { ...out, additionalContext: d.text } } : {}
}

async function main() {
  const agent = process.argv[2] ?? 'claude'
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  let e = {}
  try { e = JSON.parse(input) } catch {}
  const command = e.tool_input?.command ?? e.command ?? ''
  const d = command ? decide(command) : null
  // Nothing to say: Cursor and Gemini expect an explicit allow, the others take silence.
  const answer = d ? respond(agent, d) : respond(agent, { level: 0, text: '' })
  process.stdout.write(JSON.stringify(answer))
}

// Never break the agent: on any failure, answer "allow" in its format (Cursor blocks on missing or invalid output).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => process.stdout.write(JSON.stringify(respond(process.argv[2] ?? 'claude', { level: 0, text: '' }))))
}
