export function completionLabel (turnStatus: string, goalStatus: string): string {
  if (turnStatus !== 'completed') return `任务未完成：${turnStatus || '回合状态未知'}`
  if (goalStatus === 'complete') return '任务已完成'
  if (goalStatus === 'active') return '目标仍未完成；Codex 可自动继续，也可点击“继续”'
  return `任务未完成：目标状态 ${goalStatus || '未知'}`
}
