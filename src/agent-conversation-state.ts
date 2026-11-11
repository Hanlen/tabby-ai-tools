export type ConversationOutcome = 'running' | 'complete' | 'interrupted' | 'stopped' | 'incomplete' | 'limited' | 'blocked' | 'failed' | 'unknown'
export type NavigationTermination = 'execution_limit' | 'unfinished' | 'external'
export interface ConversationEvidence {
  stopRequested?: boolean
  terminationReason?: NavigationTermination
  goalStatus?: string
  /** A completed native turn may still be awaiting its final goal observation. */
  awaitingGoal?: boolean
  error?: { codexErrorInfo?: unknown }
}

/** Provider transport status alone cannot establish a user stop or task failure. */
export function conversationOutcome (turn: string, evidence: ConversationEvidence = {}): ConversationOutcome {
  if (turn === 'inProgress') return 'running'
  if (turn === 'interrupted' && evidence.stopRequested) return 'stopped'
  const info = evidence.error?.codexErrorInfo
  const code = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : ''
  if (evidence.terminationReason === 'execution_limit' || ['budgetLimited', 'tokenLimitReached', 'usageLimited'].includes(evidence.goalStatus || '') ||
      ['contextWindowExceeded', 'sessionBudgetExceeded', 'maxTurnsExceeded', 'maxOutputTokensExceeded'].includes(code || '')) return 'limited'
  if (evidence.terminationReason === 'unfinished') return 'incomplete'
  if (evidence.terminationReason === 'external') return 'blocked'
  if (turn === 'interrupted') return 'interrupted'
  if (turn === 'failed') return 'unknown'
  if (turn !== 'completed') return 'unknown'
  if (evidence.awaitingGoal) return 'running'
  if (['blocked', 'paused'].includes(evidence.goalStatus || '')) return 'blocked'
  if (evidence.goalStatus === 'active') return 'incomplete'
  if (evidence.goalStatus && evidence.goalStatus !== 'complete') return 'unknown'
  return 'complete'
}

export function restoredOutcome (turn: string, saved?: ConversationOutcome, evidence: ConversationEvidence = {}): ConversationOutcome {
  if (turn === 'inProgress') return 'running'
  // Legacy failed snapshots have no cause; they must not manufacture a red stop.
  if (saved === 'failed') return 'unknown'
  if (saved && saved !== 'unknown' && saved !== 'running') {
    if (turn === 'failed' && saved === 'complete') return conversationOutcome(turn, evidence)
    if (turn === 'interrupted' && saved === 'complete') return 'interrupted'
    return saved
  }
  return conversationOutcome(turn, evidence)
}

export function outcomeLabel (outcome?: ConversationOutcome): string {
  return ({ running: '进行中', complete: '本次执行已完成', interrupted: '已中断', stopped: '用户已停止',
    incomplete: '任务尚未完成', limited: '达到执行上限，任务未完成', blocked: '等待外部条件',
    failed: '任务结果未知', unknown: '任务结果未知' })[outcome || 'unknown']
}
