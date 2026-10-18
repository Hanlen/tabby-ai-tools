import { createHash } from 'crypto'
import type { ModelToolCall, ToolResult } from './api-provider'

interface Observation { fingerprint: string; operation: string; action: string; outcome: boolean }
export interface ToolLoopState { observations: Observation[]; reads: Record<string, string> }
export interface ToolLoopEvidence { period: number; repeats: number; actions: string[] }

function canonical (value: any): any {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

function parsed (value: string): any {
  try { return JSON.parse(value) } catch { return value }
}

function argumentsFor (call: ModelToolCall): any {
  let args = parsed(call.arguments)
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    args = { ...args }
    // Waiting and explanatory prose do not change the operation being attempted.
    if (call.name === 'read_tab') delete args.waitMs
    if (call.name === 'send_input') delete args.purpose
    if (call.name === 'agent_goal_update') delete args.evidence
  }
  return args
}

function hash (value: any): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex') }

/** Compare newly appended terminal lines, rather than growing copies of scrollback. */
function newOutput (previous: string | undefined, current: string): string {
  if (previous === undefined) return current
  if (previous === current) return ''
  if (current.startsWith(previous)) return current.slice(previous.length).replace(/^\n/, '')
  const before = previous.split('\n'), after = current.split('\n')
  for (let overlap = Math.min(before.length, after.length); overlap > 0; overlap--) {
    if (before.slice(-overlap).every((line, index) => line === after[index])) return after.slice(overlap).join('\n')
  }
  // A redraw or replacement is new evidence; do not guess which characters matter.
  return current
}

/** Conservative evidence of repeated tool outcomes; does not infer semantic equivalence. */
export class ApiToolLoopGuard {
  readonly state: ToolLoopState

  constructor (saved?: ToolLoopState) {
    this.state = {
      observations: (Array.isArray(saved?.observations) ? saved!.observations : []).filter(item =>
        item && /^[a-f0-9]{64}$/.test(item.fingerprint) && /^[a-f0-9]{64}$/.test(item.operation) && typeof item.action === 'string' && typeof item.outcome === 'boolean').slice(-96)
        .map(item => ({ fingerprint: item.fingerprint, operation: item.operation, action: item.action.slice(0, 240), outcome: item.outcome })),
      reads: Object.fromEntries(Object.entries(saved?.reads || {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .slice(-16).map(([tabId, text]) => [tabId, text.slice(-20000)])),
    }
  }

  before (call: ModelToolCall): ToolLoopEvidence | undefined {
    if (!['send_input', 'interact_tab'].includes(call.name)) return undefined
    const evidence = this.detect()
    if (evidence && this.state.observations[this.state.observations.length - evidence.period].operation === hash([call.name, argumentsFor(call)])) return evidence
    return undefined
  }

  record (call: ModelToolCall, output: ToolResult): ToolLoopEvidence | undefined {
    const args = argumentsFor(call)
    let result = parsed(output.result)
    if (call.name === 'read_tab' && typeof args?.tabId === 'string' && typeof result?.text === 'string') {
      const current = result.text.replace(/\r\n/g, '\n').trimEnd()
      const previous = Object.prototype.hasOwnProperty.call(this.state.reads, args.tabId) ? this.state.reads[args.tabId] : undefined
      const delta = newOutput(previous, current)
      delete this.state.reads[args.tabId]
      this.state.reads[args.tabId] = current.slice(-20000)
      for (const tabId of Object.keys(this.state.reads).slice(0, -16)) delete this.state.reads[tabId]
      if (!delta && (result.controlledByAI || result.runningProcesses === null || result.runningProcesses?.length)) {
        // An unchanged screen during a live/unknown process is waiting, not proof of a loop.
        this.state.observations = []
        return undefined
      }
      result = { ...result, text: delta }
    }
    const action = `${call.name} ${JSON.stringify(canonical(args))}`.slice(0, 240)
    const fingerprint = hash([call.name, args, result, !!output.error])
    const observations = this.state.observations
    // Delivery acknowledgements alone do not prove that commands failed to make progress.
    const outcome = !!output.error || !(call.name === 'send_input' && result?.sent === true)
    observations.push({ fingerprint, operation: hash([call.name, args]), action, outcome })
    if (observations.length > 96) observations.shift()
    return this.detect()
  }

  private detect (): ToolLoopEvidence | undefined {
    const observations = this.state.observations
    // Require three complete repetitions, including matching results, before stopping.
    for (let period = 1; period <= Math.min(32, Math.floor(observations.length / 3)); period++) {
      const end = observations.length
      if (observations.slice(-period).some(item => item.outcome) &&
        observations.slice(end - period * 2).every((item, index) => item.fingerprint === observations[end - period * 3 + index].fingerprint)) {
        return { period, repeats: 3, actions: observations.slice(-period).map(item => item.action) }
      }
    }
    return undefined
  }
}
