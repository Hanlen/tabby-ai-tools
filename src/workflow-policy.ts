import { TERMINAL_INPUT_MAX_LENGTH } from './terminal-limits'

/** Small declarative predicates; never execute expressions supplied by a model. */
export interface WorkflowCondition {
  source: 'prompt' | 'screen' | 'commandState'
  op: 'equals' | 'contains' | 'not_contains'
  value: string
}
export type WorkflowResponse = { kind: 'answer'; text: string } | { kind: 'key'; key: string; shift?: boolean; alt?: boolean; ctrl?: boolean }
export interface WorkflowInteraction {
  id: string
  intent: string
  mode: 'model' | 'manual'
  expectedProcess?: string
  rules: { when: WorkflowCondition[]; response: WorkflowResponse }[]
  observed: boolean
}
export interface WorkflowPolicy {
  /** Hand control to the main model before this operation; resume after it submits the step. */
  decision?: string
  when?: WorkflowCondition[]
  verify?: { command: string; expect: WorkflowCondition[] }
  interactions?: WorkflowInteraction[]
}
export interface WorkflowQuestion { id: string; question: string; intent: string; mode: 'model' | 'manual'; previousChoice?: string }
export interface WorkflowObservation { text: string; commandState?: string; runningProcesses?: string[] | null; controlledByAI?: boolean; interaction?: any }

const bounded = (v: any, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max
export function validConditions (v: any): v is WorkflowCondition[] {
  return Array.isArray(v) && v.length > 0 && v.length <= 8 && v.every(c => c &&
    ['prompt', 'screen', 'commandState'].includes(c.source) && ['equals', 'contains', 'not_contains'].includes(c.op) && bounded(c.value, 400))
}
export function validResponse (v: any): v is WorkflowResponse {
  return !!v && (v.kind === 'answer' ? bounded(v.text, 1000) && !/[\x00-\x1f\x7f]/.test(v.text)
    : v.kind === 'key' && ['Enter', 'Tab', 'Escape', 'Space', 'Up', 'Down', 'Left', 'Right', 'Home', 'End'].includes(v.key) &&
      ['shift', 'alt', 'ctrl'].every(k => v[k] === undefined || typeof v[k] === 'boolean'))
}
export function validPolicy (v: any): v is WorkflowPolicy {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => ['decision', 'when', 'verify', 'interactions'].includes(k)) &&
    (v.decision === undefined || bounded(v.decision, 600)) &&
    (v.when === undefined || validConditions(v.when)) &&
    (v.verify === undefined || bounded(v.verify?.command, TERMINAL_INPUT_MAX_LENGTH) && validConditions(v.verify.expect) && v.verify.expect.some((c: WorkflowCondition) => c.source !== 'commandState' && c.op !== 'not_contains')) &&
    (v.interactions === undefined || Array.isArray(v.interactions) && v.interactions.length <= 32 &&
      new Set(v.interactions.map((i: any) => i?.id)).size === v.interactions.length && v.interactions.every((i: any) => i &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(i.id) && bounded(i.intent, 600) && ['model', 'manual'].includes(i.mode) && typeof i.observed === 'boolean' &&
        (i.expectedProcess === undefined || /^[a-zA-Z0-9_.-]{1,80}$/.test(i.expectedProcess)) &&
        Array.isArray(i.rules) && i.rules.length <= 12 && i.rules.every((r: any) => validConditions(r?.when) && validResponse(r?.response))))
}
export function matchesConditions (conditions: WorkflowCondition[], observation: WorkflowObservation): boolean {
  if (!validConditions(conditions)) return false
  return conditions.every(condition => {
    const text = String(observation.text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trimEnd()
    const actual = condition.source === 'commandState' ? observation.commandState || 'unknown'
      : condition.source === 'prompt' ? text.split(/\r?\n/).filter(s => s.trim()).slice(-1).join('').trim() : text.slice(-4000)
    return condition.op === 'equals' ? actual === condition.value : condition.op === 'contains' ? actual.includes(condition.value) : !actual.includes(condition.value)
  })
}

const conditionSchema = {
  type: 'object', additionalProperties: false,
  properties: { source: { type: 'string', enum: ['prompt', 'screen', 'commandState'] }, op: { type: 'string', enum: ['equals', 'contains', 'not_contains'] }, value: { type: 'string', maxLength: 400 } },
  required: ['source', 'op', 'value'],
}
const conditionsSchema = { type: 'array', minItems: 1, maxItems: 8, items: conditionSchema }
const responseSchema = {
  type: 'object', additionalProperties: false,
  properties: { kind: { type: 'string', enum: ['answer', 'key'] }, text: { type: 'string', maxLength: 1000 }, key: { type: 'string' }, shift: { type: 'boolean' }, alt: { type: 'boolean' }, ctrl: { type: 'boolean' } },
  required: ['kind'],
}
export const WORKFLOW_POLICY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    decision: { type: 'string', maxLength: 600, description: 'Required AI judgment before this step. The runner returns needs_model without sending the command; the main model observes the live target, decides and submits this logical step through send_input, then resumes workflow_run.' },
    when: conditionsSchema,
    verify: { type: 'object', additionalProperties: false,
      properties: { command: { type: 'string', maxLength: TERMINAL_INPUT_MAX_LENGTH }, expect: conditionsSchema }, required: ['command', 'expect'] },
    interactions: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, intent: { type: 'string', maxLength: 600 }, mode: { type: 'string', enum: ['model', 'manual'] }, expectedProcess: { type: 'string' }, observed: { type: 'boolean' },
        rules: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false,
          properties: { when: conditionsSchema, response: responseSchema }, required: ['when', 'response'] } },
      }, required: ['id', 'intent', 'mode', 'rules', 'observed'] } },
  },
}
