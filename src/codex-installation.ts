import * as path from 'path'
import { executableFile, ExecutableContext } from './codex-executable'
import { Version, compareVersions } from './codex-version'

export class CodexInstallationError extends Error {
  readonly installationFailure = true
  constructor (readonly executable: string, readonly missing: string, detail = 'missing or unreadable') {
    super(`Codex installation is incomplete: ${missing} (${detail}).\nInstallation: ${path.dirname(executable)}\nCLI: ${executable}\nUse a complete installation from the same CLI distribution; do not copy helpers between versions. This is not a login failure.`)
  }
}

export interface CodexCapabilities {
  /** False for account inspection / decision-only connections. */
  codeModeTools?: boolean
  /** Windows CLI shell execution under a sandbox (not Tabby terminal tools). */
  sandboxedExecution?: boolean
}

/** The observed Windows 0.167 alpha distribution uses external code-mode hosts.
 * Older and unrecognised layouts are not rejected merely for lacking these files.
 * Runtime errors can establish an additional requirement independently of version.
 * Batch/npm launchers own their vendor layout and must not be checked as native EXEs.
 */
export function codexCompanions (executable: string, version: Version | undefined, context: ExecutableContext & CodexCapabilities = {}): string[] {
  const windows = (context.platform || process.platform) === 'win32'
  const paths = context.paths || (windows ? path.win32 : path.posix)
  if (!windows || paths.extname(executable).toLowerCase() !== '.exe') return []
  const baseline: Version = { core: [0, 167, 0], prerelease: ['alpha', '3', '2'] }
  if (!version || compareVersions(version, baseline) < 0) return []
  return [
    ...(context.codeModeTools !== false ? ['codex-code-mode-host.exe'] : []),
    ...(context.sandboxedExecution ? ['codex-command-runner.exe'] : []),
  ].map(name => paths.join(paths.dirname(executable), name))
}

export function checkCodexInstallation (executable: string, companions: string[], context: ExecutableContext = {}): void {
  for (const file of [executable, ...companions]) {
    try { executableFile(file, context) } catch (error: any) {
      throw new CodexInstallationError(executable, file, error.code || error.message)
    }
  }
}

/** Only structured errors / stderr from our child are passed here, never chat text.
 * Auth, arbitrary ENOENTs and observation timeouts cannot trigger recovery.
 */
export function codexHelperFailure (value: string): boolean {
  const helper = '(?:code[-_ ]mode[-_ ]host|codex-code-mode-host(?:\\.exe)?|codex-command-runner(?:\\.exe)?)'
  return new RegExp(`(?:failed to spawn|failed to start|could not start)[^\\r\\n]{0,120}${helper}`, 'i').test(value) ||
    new RegExp(`${helper}[^\\r\\n]{0,600}(?:\\r?\\n[^\\r\\n]{0,600}){0,2}(?:no such file|not found|os error 2\\b|ENOENT\\b|cannot find)`, 'i').test(value)
}

export function installationFailure (error: any): boolean { return error?.installationFailure === true || codexHelperFailure(String(error?.message || error)) }
