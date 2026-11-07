import { randomBytes } from 'crypto'
import { execStream, TransferTarget } from './attachment-transport'

export interface RemoteProcessIdentity { pid: number; tty: string; started: string; executable: string }

const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'"

// No cmdline, environment or credentials are collected. Linux /proc is an
// intentional boundary; a host without it remains unsupported, never guessed.
export const REMOTE_PROCESSES = `test -d /proc/self || exit 69
LC_ALL=C ps -u "$(id -u)" -o pid=,pgid=,tpgid=,tty= | while read -r pid pgid fg tty; do
  test "$pgid" = "$fg" || continue
  case "$tty" in pts/[0-9]*) ;; *) continue ;; esac
  exe=$(readlink "/proc/$pid/exe") || continue
  started=$(sed 's/^.*) //' "/proc/$pid/stat" | awk '{print $20}') || continue
  printf '%s\\t%s\\t%s\\t%s\\n' "$pid" "$tty" "$started" "$exe"
done`

export function parseRemoteProcesses (value: string, expected: string): RemoteProcessIdentity[] {
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(expected)) throw new Error('expectedProcess must be an executable name')
  const result: RemoteProcessIdentity[] = []
  for (const line of value.trim().split('\n')) {
    const match = /^(\d+)\t(pts\/\d+)\t(\d+)\t(\/[^\t\r\n]+)$/.exec(line)
    if (!match) continue
    const executable = match[4].replace(/ \(deleted\)$/, '')
    if (executable.substring(executable.lastIndexOf('/') + 1) !== expected) continue
    result.push({ pid: Number(match[1]), tty: match[2], started: match[3], executable: match[4] })
  }
  return result
}

/** Bind a foreground PID + start time to this exact SSH pane by observing a
 * private random OSC written to its PTY output from an independent exec channel.
 * Nothing is sent to stdin, no signal is sent, and no terminal command is pasted.
 * A host-wide matching name alone can never grant input ownership.
 */
export async function verifyRemoteProcess (target: TransferTarget, expected: string, previous?: RemoteProcessIdentity,
  run: typeof execStream = execStream): Promise<RemoteProcessIdentity | null> {
  if (typeof target.ssh?.ssh?.openSessionChannel !== 'function' || !target.session?.output$) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  const exec = async (script: string): Promise<string> => {
    let output = ''
    // Channel opening itself may hang in the host adapter before it registers
    // its abort handler. Bound our wait as well as the channel operation.
    await new Promise<void>((resolve, reject) => {
      const cancel = () => reject(new Error('Remote process inspection timed out'))
      controller.signal.addEventListener('abort', cancel, { once: true })
      void Promise.resolve().then(() => run(target, script, controller.signal, async bytes => {
        output += bytes.toString('utf8')
        if (output.length > 32768) { controller.abort(); throw new Error('Remote process inspection exceeded 32 KiB') }
      })).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancel))
      if (controller.signal.aborted) cancel()
    })
    if (!target.valid()) throw new Error('SSH session changed during process inspection')
    return output
  }
  let subscription: { unsubscribe(): void } | undefined
  try {
    const candidates = parseRemoteProcesses(await exec(REMOTE_PROCESSES), expected)
      .filter(item => !previous || item.pid === previous.pid && item.tty === previous.tty && item.started === previous.started && item.executable === previous.executable)
    if (!candidates.length || candidates.length > 16) return null
    const nonce = randomBytes(24).toString('hex')
    let tail = '', found: RemoteProcessIdentity | null = null
    let wake!: () => void
    const observed = new Promise<void>(resolve => { wake = resolve })
    const abort = () => wake()
    controller.signal.addEventListener('abort', abort, { once: true })
    subscription = target.session.output$.subscribe((chunk: Buffer | string) => {
      tail = (tail + String(chunk)).slice(-4096)
      for (const item of candidates) if (tail.includes(`\x1b]777;tabby-process;${nonce};${item.pid}\x07`)) { found = item; wake() }
    })
    const scripts = candidates.map(item => `
test "$(readlink /proc/${item.pid}/exe)" = ${quote(item.executable)} || exit 70
test "$(sed 's/^.*) //' /proc/${item.pid}/stat | awk '{print $20}')" = ${quote(item.started)} || exit 70
test "$(LC_ALL=C ps -p ${item.pid} -o pgid=,tpgid=,tty= | awk '{if ($1 == $2) print $3}')" = ${quote(item.tty)} || exit 70
printf '\\033]777;tabby-process;${nonce};${item.pid}\\007' > ${quote('/dev/' + item.tty)} || exit 70`)
    await exec(scripts.join('\n'))
    await observed
    controller.signal.removeEventListener('abort', abort)
    if (controller.signal.aborted || !target.valid()) return null
    return found
  } catch { return null } finally {
    clearTimeout(timer)
    controller.abort()
    subscription?.unsubscribe()
  }
}
