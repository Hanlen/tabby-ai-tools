import { randomBytes } from 'crypto'

/** One lease per task and terminal. Authentication always happens interactively outside AI input. */
export class SudoWorkflowLease {
  readonly variable = '__tabby_sudo_' + randomBytes(12).toString('hex')
  wrap (command: string): string {
    const v = this.variable
    // Double-fork the refresher so terminal foreground-process detection does not see it as a task.
    // It inherits this terminal's timestamp context. Never change sudoers or extend timestamps globally.
    return `if sudo -n -v; then
if [ -z "\${${v}:-}" ] || [ ! -f "$${v}/active" ]; then
${v}=$(mktemp -d "\${TMPDIR:-/tmp}/tabby-sudo.XXXXXXXX")
if [ -n "$${v}" ] && (umask 077; : > "$${v}/active"); then
(sh -c 'n=0; while [ -f "$1/active" ] && kill -0 "$2" 2>/dev/null && [ "$n" -lt 1440 ]; do sudo -n -v || break; n=$((n+1)); sleep 30; done; rm -f "$1/active"; rmdir "$1" 2>/dev/null' sh "$${v}" "$$" </dev/null >/dev/null 2>&1 &)
fi
fi
${command}
else
printf '%s\\n' 'Tabby: sudo authentication required. Run sudo -v or sudo ls in THIS terminal, then retry.' >&2
fi`
  }
  cleanup (): string {
    const v = this.variable
    return `if [ -n "\${${v}:-}" ]; then rm -f "$${v}/active"; unset ${v}; fi`
  }
}
