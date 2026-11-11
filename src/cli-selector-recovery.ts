import type { ConfigService } from 'tabby-core'
import type { CodexClient } from './codex-client'
import { normalizeExecutable } from './codex-executable'

const bound = new WeakSet<CodexClient>()

/** Compare with the current setting: a late discovery must not erase a user's edit. */
export function persistInvalidCodexSelector (client: CodexClient, config: ConfigService): void {
  if (bound.has(client)) return
  bound.add(client)
  client.on('invalidExecutable', (configured: string) => {
    const settings = config.store.codexAgent
    if (normalizeExecutable(settings.executable) !== normalizeExecutable(configured)) return
    settings.executable = ''
    void config.save().catch(() => client.emit('diagnostic', 'Unable to save cleared Codex CLI setting; automatic discovery is active for this connection.\n'))
  })
}
