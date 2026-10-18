import { ApiProfile } from './agent-types'
import { apiUrl, streamApi } from './api-transport'

export interface ToolDefinition { name: string; description: string; inputSchema: any }
export interface ModelToolCall { id: string; name: string; arguments: string }
export interface ToolResult { id: string; result: string; error?: boolean }
export interface StreamProgress { phase: 'thinking' | 'tools'; receivedChars: number }
export interface ModelResult {
  text: string
  messages: any[]
  tools: ModelToolCall[]
  inputTokens: number
  outputTokens: number
  totalTokens: number
  usageReported: boolean
  stop: 'end' | 'tools'
}

export class ApiProviderAdapter {
  constructor (readonly profile: ApiProfile, private key: string) {}

  user (text: string): any { return { role: 'user', content: text } }

  toolResults (results: ToolResult[]): any[] {
    if (this.profile.provider === 'openai') return results.map(result => ({ type: 'function_call_output', call_id: result.id, output: result.result }))
    if (this.profile.provider === 'claude') return [{ role: 'user', content: results.map(result => ({ type: 'tool_result', tool_use_id: result.id, content: result.result, is_error: !!result.error })) }]
    return results.map(result => ({ role: 'tool', tool_call_id: result.id, content: result.result }))
  }

  async generate (messages: any[], system: string, tools: ToolDefinition[], signal: AbortSignal, onText: (text: string) => void, onProgress?: (progress: StreamProgress) => void): Promise<ModelResult> {
    const p = this.profile
    const openai = p.provider === 'openai'
    const claude = p.provider === 'claude'
    const path = openai ? 'responses' : claude ? 'messages' : 'chat/completions'
    const headers: Record<string, string> = claude ? { 'x-api-key': this.key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${this.key}` }
    const body: any = { model: p.model, stream: true }
    if (openai) {
      Object.assign(body, { instructions: system, input: messages, store: false, include: ['reasoning.encrypted_content'], max_output_tokens: p.maxOutputTokens,
        ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })) } : {}) })
      if (p.reasoningEffort) body.reasoning = { effort: p.reasoningEffort }
    } else if (claude) {
      Object.assign(body, { system, messages, max_tokens: p.maxOutputTokens,
        ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}) })
      if (p.thinking === 'enabled') body.thinking = { type: 'adaptive' }
      if (p.thinking === 'disabled') body.thinking = { type: 'disabled' }
      if (p.reasoningEffort) body.output_config = { effort: p.reasoningEffort }
    } else {
      const history = p.provider === 'deepseek' ? messages.map(message => message.role === 'assistant'
        ? { ...message, content: message.content || '', reasoning_content: message.reasoning_content || '' } : message) : messages
      Object.assign(body, { messages: [{ role: 'system', content: system }, ...history], max_tokens: p.maxOutputTokens,
        ...(p.provider === 'deepseek' ? { stream_options: { include_usage: true } } : {}),
        ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}) })
      if (p.thinking !== 'default') body.thinking = { type: p.thinking }
      if (p.reasoningEffort && p.thinking !== 'disabled') body.reasoning_effort = p.reasoningEffort
    }
    let inputTokens = 0, outputTokens = 0, totalTokens = 0
    let usageReported = false
    let stop = ''
    let text = '', reasoning = ''
    const calls = new Map<number, any>()
    const blocks: any[] = []
    let responseOutput: any[] | undefined
    let claudeStopped = false
    let reasoningChars = 0, toolChars = 0
    const progress = (phase: StreamProgress['phase'], delta: string) => {
      if (!delta) return
      if (phase === 'thinking') reasoningChars += delta.length
      else toolChars += delta.length
      onProgress?.({ phase, receivedChars: phase === 'thinking' ? reasoningChars : toolChars })
    }
    for await (const event of streamApi(apiUrl(p.baseUrl, path), headers, body, signal)) {
      if (openai) {
        if (event.type === 'response.output_text.delta') onText(event.delta || '')
        if (event.type === 'response.reasoning_summary_text.delta') progress('thinking', event.delta || '')
        if (event.type === 'response.function_call_arguments.delta') progress('tools', event.delta || '')
        if (event.type === 'response.completed') {
          responseOutput = event.response?.output
          const usage = event.response?.usage
          usageReported = !!usage
          inputTokens = usage?.input_tokens || 0; outputTokens = usage?.output_tokens || 0
          totalTokens = usage?.total_tokens ?? inputTokens + outputTokens
          stop = 'end'
        }
        if (['response.failed', 'response.incomplete'].includes(event.type)) throw new Error('模型输出失败或达到输出上限；本轮未完成')
      } else if (claude) {
        if (event.type === 'message_start') {
          const usage = event.message?.usage
          usageReported = !!usage
          inputTokens = (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0)
        }
        if (event.type === 'content_block_start') blocks[event.index] = { ...event.content_block }
        if (event.type === 'content_block_delta') {
          const block = blocks[event.index]
          if (!block) throw new Error('Claude 流缺少 content_block_start')
          const delta = event.delta
          if (delta.type === 'text_delta') { block.text = (block.text || '') + delta.text; onText(delta.text) }
          if (delta.type === 'thinking_delta') { block.thinking = (block.thinking || '') + delta.thinking; progress('thinking', delta.thinking) }
          if (delta.type === 'signature_delta') block.signature = (block.signature || '') + delta.signature
          if (delta.type === 'input_json_delta') { block.partial = (block.partial || '') + delta.partial_json; progress('tools', delta.partial_json) }
        }
        if (event.type === 'message_delta') {
          stop = event.delta?.stop_reason || stop
          outputTokens = event.usage?.output_tokens || 0
        }
        if (event.type === 'message_stop') {
          claudeStopped = true
          totalTokens = inputTokens + outputTokens
          if (!stop) throw new Error('Claude 流缺少 stop_reason')
        }
      } else {
        const choice = event.choices?.[0]
        const delta = choice?.delta
        if (delta?.content) { text += delta.content; onText(delta.content) }
        if (delta?.reasoning_content) { reasoning += delta.reasoning_content; progress('thinking', delta.reasoning_content) }
        for (const part of delta?.tool_calls || []) {
          const call = calls.get(part.index) || { id: '', name: '', arguments: '' }
          if (part.id) call.id = part.id
          if (part.function?.name) call.name += part.function.name
          if (part.function?.arguments) call.arguments += part.function.arguments
          progress('tools', part.function?.arguments || part.function?.name || '')
          if (call.arguments.length > 1024 * 1024) throw new Error('工具参数过大')
          calls.set(part.index, call)
        }
        if (choice?.finish_reason) stop = choice.finish_reason
        if (event.usage) {
          usageReported = true
          inputTokens = event.usage.prompt_tokens || 0; outputTokens = event.usage.completion_tokens || 0
          totalTokens = event.usage.total_tokens ?? inputTokens + outputTokens
        }
      }
    }
    if (signal.aborted) throw new Error('请求已停止')
    if (claude && !claudeStopped) throw new Error('Claude 流意外中断')
    if (!['end', 'stop', 'tool_calls', 'end_turn', 'tool_use', 'stop_sequence'].includes(stop)) throw new Error(`模型回复未正常完成（${stop || '流中断'}）`)
    let output: any[], toolCalls: ModelToolCall[]
    if (openai) {
      if (!Array.isArray(responseOutput)) throw new Error('OpenAI 流缺少完整 output')
      output = responseOutput
      toolCalls = output.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, name: item.name, arguments: item.arguments }))
    } else if (claude) {
      for (const block of blocks) {
        if (!block) throw new Error('Claude 流内容块不连续')
        if (block.type === 'tool_use' && block.partial !== undefined) { block.input = JSON.parse(block.partial); delete block.partial }
      }
      output = [{ role: 'assistant', content: blocks }]
      toolCalls = blocks.filter(block => block.type === 'tool_use').map(block => ({ id: block.id, name: block.name, arguments: JSON.stringify(block.input) }))
    } else {
      toolCalls = [...calls.values()]
      output = [{ role: 'assistant', content: text || null, ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}) }]
    }
    if (toolCalls.some(call => !call.id || !call.name || typeof call.arguments !== 'string') || new Set(toolCalls.map(call => call.id)).size !== toolCalls.length) throw new Error('API 返回了无效或重复的工具调用')
    const finalText = openai ? output.filter(item => item.type === 'message').flatMap(item => item.content || []).filter(part => ['output_text', 'refusal'].includes(part.type)).map(part => part.text || part.refusal || '').join('')
      : claude ? blocks.filter(block => block.type === 'text').map(block => block.text).join('') : text
    return { text: finalText, messages: output, tools: toolCalls, inputTokens, outputTokens, totalTokens, usageReported, stop: toolCalls.length ? 'tools' : 'end' }
  }
}
