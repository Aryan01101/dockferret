// Static check: what an agent skill, plugin, MCP server or npm package can do, with file:line evidence.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'

// [id, severity, what it means for you, pattern]. Checked line by line.
const RULES = [
  ['pipe-shell', 'high', 'pipes a download straight into a shell', /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i],
  ['safety-off', 'high', 'turns off safety checks', /dangerously|skip-permissions|--no-verify|--disable-sandbox/i],
  ['hidden-exec', 'high', 'decodes and runs hidden content', /base64\s+(-d|--decode)[^\n]*\|\s*(ba|z)?sh|\beval\s*\(\s*(atob|Buffer\.from)/i],
  ['override', 'high', 'tries to override your instructions', /ignore (all |any )?(previous|prior|above) instructions|(do not|don't|never) (tell|inform|show|alert) the user (about|that you|what you|you)|without (telling|informing|notifying) the user/i],
  ['credentials', 'high', 'reads keys or credentials', /~\/\.ssh|\bid_(rsa|ed25519)\b|\.aws\/credentials|\bkeychain\b|security find-(generic|internet)-password|\.npmrc|\.netrc/i],
  ['eval', 'high', 'runs dynamically built code', /\beval\(|new Function\(/],
  ['rm-rf', 'medium', 'deletes files recursively', /\brm\s+-[a-z]*(rf|fr)\b|shutil\.rmtree|fs\.rm(Sync)?\([^)]*recursive/i],
  ['sudo', 'medium', 'asks for admin rights', /\bsudo\s/],
  ['background', 'medium', 'keeps running in the background', /\bnohup\b|\bscreen\s+-d|\btmux\s+new\b.*-d|\bdisown\b|\bcaffeinate\b|\blaunchctl\s+(load|bootstrap)|\bcrontab\b|systemctl\s+enable|\bpm2\s+start/i],
  ['exec', 'medium', 'runs commands on your machine', /child_process|\bexecSync\s*\(|\bspawn(Sync)?\s*\(|\bsubprocess\.|\bos\.system\s*\(|\$\.process\.(run|spawn)|Bun\.spawn|Deno\.Command/],
  ['network', 'medium', 'sends network requests', /\bfetch\s*\(\s*['"`]?https?:|\baxios\b|\bhttps?\.request\s*\(|\brequests\.(get|post|put)|\burllib\.request|\bhttpx\.|\$\.http\.fetch|\bcurl\s+-|\bwget\s+http/i],
  ['secrets-env', 'medium', 'reads secrets from environment variables', /(process\.env|os\.environ(\.get)?|getenv)\s*[[.(]\s*['"]?[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)/],
  ['browser', 'medium', 'drives a web browser', /\bplaywright\b|\bpuppeteer\b|\bselenium\b|--remote-debugging|chrome-devtools/i],
  ['home-write', 'medium', 'writes into your home folder', /(writeFile|appendFile|open)\w*\s*\([^)]*(~\/|os\.homedir\(\)|expanduser|HOME)/],
  ['model-calls', 'info', 'calls an AI model (costs tokens)', /@anthropic-ai\/sdk|\bimport anthropic\b|\bfrom anthropic import|api\.anthropic\.com|\bimport openai\b|\bfrom openai import|['"]openai['"]\)?\s*;?\s*$|api\.openai\.com|\bclaude\s+(-p|--print)\b|["']claude["']\s*,\s*["'](-p|--print)["']|\bcodex\s+exec\b|["']codex["']\s*,\s*["']exec["']|generativelanguage|api\.mistral/i],
]
const TEXT = /\.(md|mdx|txt|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|rb|go|rs|toml|ya?ml|ps1)$/i
// JSON is data except where it holds commands an agent will run. Type declarations are generated, not behaviour.
const COMMAND_JSON = new Set(['.mcp.json', 'mcp.json', 'hooks.json', 'settings.json'])
const isScanned = name => !name.endsWith('.d.ts') && (TEXT.test(name) || COMMAND_JSON.has(name) || !name.includes('.'))
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__'])
const MAX_FILE = 1_000_000
const SEVERITY = { high: 3, medium: 2, info: 1 }
// In docs these are examples, not behaviour. Shell lines in docs still count: skills are instructions an agent follows.
const CODE_ONLY = new Set(['eval', 'exec', 'secrets-env', 'home-write'])
const DOC = /\.(md|mdx|txt)$/i

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) walk(p, out)
    else out.push({ p, size: s.size, name })
  }
  return out
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

export function detectKinds(dir, files) {
  const rel = files.map(f => relative(dir, f))
  const kinds = []
  if (rel.some(f => basename(f) === 'SKILL.md')) kinds.push('skill')
  if (rel.some(f => f.endsWith('.claude-plugin/plugin.json'))) kinds.push('claude-plugin')
  if (rel.some(f => f.endsWith('.codex-plugin/plugin.json')) || readJson(join(dir, 'plugin.json'))?.extensions?.['com.openai']) kinds.push('codex-plugin')
  const hooks = rel.find(f => f.endsWith('hooks/hooks.json'))
  if (hooks && readJson(join(dir, hooks))?.modules) kinds.push('claude-mod')
  const pkg = readJson(join(dir, 'package.json'))
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies }
  const py = ['requirements.txt', 'pyproject.toml'].map(f => join(dir, f)).filter(existsSync).map(f => readFileSync(f, 'utf8')).join('\n')
  if (deps['@modelcontextprotocol/sdk'] || /\b(mcp|fastmcp)\b/.test(py)) kinds.push('mcp-server')
  if (pkg) kinds.push('npm-package')
  return kinds.length ? kinds : ['folder']
}

export function scanDir(dir) {
  const all = walk(dir)
  const files = all.filter(f => f.size <= MAX_FILE && isScanned(f.name)).map(f => f.p)
  const hits = new Map() // rule id -> { ...rule, where: [] }
  const add = (id, severity, what, where) => {
    const h = hits.get(id) ?? { id, severity, what, where: [] }
    h.where.push(where)
    hits.set(id, h)
  }

  const pkg = readJson(join(dir, 'package.json'))
  for (const s of ['preinstall', 'install', 'postinstall']) {
    if (pkg?.scripts?.[s]) add('install-script', 'high', 'runs code the moment it is installed', `package.json "${s}": ${pkg.scripts[s].slice(0, 80)}`)
  }

  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n')
    const isDoc = DOC.test(f)
    lines.forEach((line, i) => {
      if (/[A-Za-z0-9+/]{300,}={0,2}/.test(line)) add('blob', 'medium', 'contains a long encoded blob', `${relative(dir, f)}:${i + 1}`)
      for (const [id, severity, what, rx] of RULES) {
        if (isDoc && CODE_ONLY.has(id)) continue
        if (rx.test(line)) add(id, severity, what, `${relative(dir, f)}:${i + 1}`)
      }
    })
  }
  // Running commands plus network access is the shape of something that can send your data out.
  if (hits.has('exec') && hits.has('network')) {
    add('exfil-shape', 'high', 'can run commands and send data out', 'combination of the two findings below')
  }

  const findings = [...hits.values()].sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity] || a.id.localeCompare(b.id))
  const worst = findings.find(f => f.severity !== 'info')?.severity
  const verdict = worst === 'high' ? 'review first' : worst === 'medium' ? 'check before installing' : 'low risk'
  return { kinds: detectKinds(dir, all.map(f => f.p)), files: files.length, findings, verdict }
}

// Turns "./dir", a GitHub URL or an npm package name into a local folder.
export function resolveTarget(target) {
  if (existsSync(target)) return { dir: target, source: 'local folder', cleanup() {} }
  const tmp = mkdtempSync(join(tmpdir(), 'dockferret-'))
  const cleanup = () => rmSync(tmp, { recursive: true, force: true })
  try {
  const gh = target.match(/^(https?:\/\/)?github\.com\/([\w.-]+\/[\w.-]+?)(\.git)?(\/tree\/([^/]+)\/?(.*))?$/)
  if (gh) {
    const [, , repo, , , branch, sub] = gh
    const args = ['clone', '--depth', '1', ...(branch ? ['--branch', branch] : []), `https://github.com/${repo}.git`, join(tmp, 'repo')]
    execFileSync('git', args, { stdio: 'ignore', timeout: 120_000 })
    return { dir: join(tmp, 'repo', sub ?? ''), source: `github.com/${repo}`, cleanup }
  }
  const name = target.replace(/^npm:/, '')
  // --ignore-scripts: never run the thing we are checking.
  const file = execFileSync('npm', ['pack', name, '--ignore-scripts', '--silent', '--pack-destination', tmp], { encoding: 'utf8', timeout: 120_000 }).trim().split('\n').pop()
  execFileSync('tar', ['-xzf', join(tmp, file), '-C', tmp], { stdio: 'ignore' })
  return { dir: join(tmp, 'package'), source: `npm:${name}`, cleanup }
  } catch (e) {
    cleanup()
    throw new Error(`couldn't fetch ${target}: ${e.message.split('\n')[0]}`)
  }
}

const DOT = { high: '●', medium: '◐', info: '○' }

export function formatReport(name, source, r) {
  const out = [`dockferret · ${name}  (${r.kinds.join(', ')} · ${source} · ${r.files} ${r.files === 1 ? 'file' : 'files'})`, `Verdict: ${r.verdict}`, '']
  if (!r.findings.length) out.push('No risky capabilities found in the source.')
  for (const f of r.findings) {
    out.push(`${DOT[f.severity]} ${f.severity.padEnd(6)} ${f.what}`)
    for (const w of f.where.slice(0, 3)) out.push(`           ${w}`)
    if (f.where.length > 3) out.push(`           …and ${f.where.length - 3} more`)
  }
  out.push('', 'This is a static read of the source. Run it in the sandbox to see what it actually does: dockferret run <target> -- <command>')
  return out.join('\n')
}
