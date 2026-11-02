import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { spawn as spawnWindowsLauncher } from 'cross-spawn'
import { codexEnvironment } from './codex-executable'
import { terminateCodexProcess } from './codex-process'

export interface VersionContext {
  signal?: AbortSignal
  versionTimeoutMs?: number
  cwd?: string
}

interface Version { core: number[]; prerelease?: string[] }

function parseVersion (output: string): Version | undefined {
  const match = /^codex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)(?:-([\da-z.-]+))?(?:\+[\da-z.-]+)?$/i.exec(output.trim())
  if (!match) return undefined
  const core = match.slice(1, 4).map(Number)
  if (!core.every(Number.isSafeInteger)) return undefined
  return { core, prerelease: match[4]?.split('.') }
}

function compareVersions (a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i]
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i]; const right = b.prerelease[i]
    if (left === right) continue
    if (left === undefined) return -1
    if (right === undefined) return 1
    const ln = /^\d+$/.test(left); const rn = /^\d+$/.test(right)
    if (ln && rn) return left.length - right.length || (left < right ? -1 : 1)
    if (ln !== rn) return ln ? -1 : 1
    return left < right ? -1 : 1
  }
  return 0
}

/** Read-only --version probe. Never starts a model or runs an installer. */
async function version (executable: string, env: NodeJS.ProcessEnv, context: VersionContext): Promise<Version | undefined> {
  return new Promise(resolve => {
    const launch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable) ? spawnWindowsLauncher : spawn
    const child = launch(executable, ['--version'], {
      cwd: context.cwd, env: codexEnvironment(env), shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    let settled = false
    let output = ''
    let bytes = 0
    const finish = async (value?: Version, closed = false): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', abort)
      if (!closed) {
        try { await terminateCodexProcess(child, { env, graceMs: 0, killTimeoutMs: 500 }) } catch { /* Discard this probe. */ }
      }
      child.stdout.destroy()
      child.stderr.destroy()
      resolve(value)
    }
    const abort = (): void => { void finish() }
    const timer = setTimeout(abort, context.versionTimeoutMs ?? 1500)
    context.signal?.addEventListener('abort', abort, { once: true })
    child.stdin.on('error', () => {})
    child.stdout.on('error', abort)
    child.stderr.on('error', abort)
    child.on('error', abort)
    child.stdin.end()
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data: Buffer) => {
      bytes += data.length
      if (bytes > 16384) abort()
      else if (stream === child.stdout) output += data.toString('utf8')
    })
    child.on('close', code => { void finish(code === 0 ? parseVersion(output) : undefined, true) })
    if (context.signal?.aborted) abort()
  })
}

/** Preserve discovery order on equal/unknown versions; never rank by file dates. */
export async function newestCodexExecutable (candidates: string[], env: NodeJS.ProcessEnv, context: VersionContext = {}): Promise<string> {
  const unique = [...new Set(candidates)]
  const versions: (Version | undefined)[] = new Array(unique.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, async () => {
    while (cursor < unique.length && !context.signal?.aborted) {
      const index = cursor++
      versions[index] = await version(unique[index], env, context)
    }
  }))
  if (context.signal?.aborted) throw new Error('Codex app-server was closed during CLI discovery')
  let best = 0
  for (let i = 0; i < unique.length; i++) {
    if (versions[i] && (!versions[best] || compareVersions(versions[i]!, versions[best]!) > 0)) best = i
  }
  return unique[best]
}
