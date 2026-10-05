// Runs a command against a copy of the target inside macOS sandbox-exec and records what it tried to do.
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { join, relative } from 'node:path'

// Language runtimes often live in the home folder; they stay readable so `node` or `python` still start.
const RUNTIME_DIRS = ['.nvm', '.npm', '.bun', '.volta', '.asdf', '.pyenv', '.cargo', '.rustup', '.local/share/fnm', '.local/bin', '.deno']
// No DNS either: an allowed resolver socket would let a tool leak data through the names it looks up.
const NET_BLOCKED = /ENOTFOUND|ECONNREFUSED|Failed to connect|Could not connect|Connection refused|connect EPERM|Network is down|EAI_AGAIN|getaddrinfo|Could not resolve host|Network is unreachable|nodename nor servname|Name or service not known|Temporary failure in name resolution/i
const FS_BLOCKED = /Operation not permitted|EPERM|Permission denied|EACCES|Read-only file system/i
const q = s => JSON.stringify(s) // sandbox profile strings use the same escaping as JSON

export function profile(root, { network = false } = {}) {
  const home = homedir()
  return [
    '(version 1)',
    '(allow default)',
    network ? '' : '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* (subpath ${q(root)}) (subpath "/dev"))`,
    `(deny file-read* (subpath ${q(home)}))`,
    `(allow file-read* ${RUNTIME_DIRS.map(d => `(subpath ${q(join(home, d))})`).join(' ')})`,
    `(allow file-read* (literal ${q(home)}))`, // stat of the home folder itself, needed by many runtimes
  ].join('\n')
}

function snapshot(dir, out = new Map()) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p, { throwIfNoEntry: false })
    if (!s) continue
    if (s.isDirectory()) { if (name !== 'node_modules' && name !== '.git') snapshot(p, out) } else out.set(p, `${s.size}:${s.mtimeMs}`)
  }
  return out
}

const pids = () => new Set(execFileSync('ps', ['-axo', 'pid='], { encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean))

function cwdOf(pid) {
  try { return execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').find(l => l.startsWith('n'))?.slice(1) } catch { return undefined }
}

export async function runSandboxed(srcDir, command, { timeoutMs = 60_000, network = false } = {}) {
  if (platform() !== 'darwin') throw new Error('The sandbox runs on macOS for now. Use `dockferret check` on other systems.')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dockferret-run-')))
  const work = join(root, 'work'), home = join(root, 'home'), tmp = join(root, 'tmp')
  cpSync(srcDir, work, { recursive: true })
  mkdirSync(home); mkdirSync(tmp)

  const before = snapshot(root)
  const pidsBefore = pids()
  const started = Date.now()
  // Only harmless variables pass through: none of your API keys or tokens reach the tool.
  const env = { PATH: process.env.PATH, LANG: process.env.LANG ?? 'en_US.UTF-8', TERM: 'dumb', HOME: home, TMPDIR: tmp }
  const child = spawn('sandbox-exec', ['-p', profile(root, { network }), '/bin/sh', '-c', command], { cwd: work, env, detached: true })

  let output = ''
  const keep = d => { if (output.length < 200_000) output += d }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL') } catch {} }, timeoutMs)
  const exitCode = await new Promise(res => child.on('close', code => res(code)))
  clearTimeout(timer)

  // Anything new still running from inside the sandbox outlived the command: report it, then stop it.
  const leftovers = [...pids()].filter(p => !pidsBefore.has(p) && cwdOf(p)?.startsWith(root))
  for (const p of leftovers) try { process.kill(Number(p), 'SIGKILL') } catch {}
  try { process.kill(-child.pid, 'SIGKILL') } catch {}

  const after = snapshot(root)
  const changed = { created: [], modified: [], deleted: [] }
  for (const [p, sig] of after) if (!before.has(p)) changed.created.push(p); else if (before.get(p) !== sig) changed.modified.push(p)
  for (const p of before.keys()) if (!after.has(p)) changed.deleted.push(p)
  const rel = p => relative(root, p).replace(/^home/, '~').replace(/^work\/?/, './')

  rmSync(root, { recursive: true, force: true })
  const lines = output.split('\n')
  return {
    command,
    exitCode: timedOut ? null : exitCode,
    timedOut,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    network,
    blockedNetwork: lines.filter(l => NET_BLOCKED.test(l)).slice(0, 5),
    blockedFiles: lines.filter(l => FS_BLOCKED.test(l)).slice(0, 5),
    leftovers: leftovers.length,
    changed: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.map(rel)])),
    outputTail: lines.slice(-15).join('\n'),
  }
}

export function formatRun(r) {
  const out = [`dockferret run · ${r.command}`, `Exit: ${r.timedOut ? 'stopped after timeout' : r.exitCode} · ${r.seconds}s · network ${r.network ? 'allowed' : 'blocked'}`, '']
  const item = (bad, text) => out.push(`${bad ? '●' : '○'} ${text}`)
  if (r.network) item(false, 'network was allowed (--net), so connections were not blocked or recorded')
  else item(r.blockedNetwork.length, r.blockedNetwork.length ? 'tried to reach the network (blocked)' : 'no network attempts seen')
  for (const l of r.blockedNetwork.slice(0, 2)) out.push(`    ${l.trim().slice(0, 140)}`)
  item(r.blockedFiles.length, r.blockedFiles.length ? 'tried to read or write outside the sandbox (blocked)' : 'stayed inside its sandbox folder')
  for (const l of r.blockedFiles.slice(0, 2)) out.push(`    ${l.trim().slice(0, 140)}`)
  item(r.leftovers, r.leftovers ? `left ${r.leftovers} process(es) running after it exited (stopped)` : 'nothing left running after it exited')
  const { created, modified, deleted } = r.changed
  item(false, `files: ${created.length} created, ${modified.length} changed, ${deleted.length} deleted`)
  for (const p of [...created, ...modified].slice(0, 8)) out.push(`    ${p}`)
  out.push('', 'Last output:', r.outputTail || '(none)')
  return out.join('\n')
}
