export interface UserQuestion {
  id: string
  header?: string
  question: string
  isOther?: boolean
  isSecret?: boolean
  options?: { label: string; description?: string }[] | null
}

export function isUserInputMethod (method?: string): boolean {
  return method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput' || method === 'local/agentMessageQuestions'
}

export function answersComplete (questions: UserQuestion[], selected: Record<string, string>, other: Record<string, string>): boolean {
  return questions.every(question => {
    const value = selected[question.id]
    return !!(value === '__other__' ? other[question.id]?.trim() : value?.trim())
  })
}

export function formatAnswers (questions: UserQuestion[], selected: Record<string, string>, other: Record<string, string>): Record<string, { answers: string[] }> {
  const answers: Record<string, { answers: string[] }> = {}
  for (const question of questions) {
    const value = selected[question.id]
    answers[question.id] = { answers: [value === '__other__' ? other[question.id].trim() : value.trim()] }
  }
  return answers
}
