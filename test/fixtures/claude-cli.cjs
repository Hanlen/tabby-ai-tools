// Offline CLI simulator: exercises real pipes and HTTP MCP without model requests.
const fs = require('node:fs')
const path = require('node:path')
const scenario = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8'))
const args = process.argv.slice(2)
const flags = ['--tools', '--strict-mcp-config', '--setting-sources', '--disable-slash-commands', '--append-system-prompt-file', '--include-partial-messages', '--system-prompt-snapshot']
if (args[0] === '--help') { console.log(flags.filter(flag => flag !== scenario.missingFlag).join('\n')); process.exit(0) }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: scenario.loggedIn !== false, authMethod: 'claude.ai' })); process.exit(scenario.loggedIn === false ? 1 : 0) }
const flag = name => args[args.indexOf(name) + 1]
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
;(async () => {
  let input = ''
  for await (const part of process.stdin) input += part
  const config = JSON.parse(fs.readFileSync(flag('--mcp-config'), 'utf8')).mcpServers.tabby
  const capture = { args, input, pid: process.pid, config, system: fs.readFileSync(flag('--append-system-prompt-file'), 'utf8'), calls: [] }
  const save = () => fs.writeFileSync(path.join(__dirname, 'capture.json'), JSON.stringify(capture))
  save()
  if (scenario.hang) { setInterval(() => {}, 1000); return }
  if (scenario.badJson) { process.stdout.write('{broken json\n'); setInterval(() => {}, 1000); return }
  const rpc = async (method, params) => {
    const response = await fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: capture.calls.length, method, params }) })
    const value = await response.json()
    capture.calls.push({ method, params, response: value })
    save()
    return value.result
  }
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })
  const { tools } = await rpc('tools/list')
  emit({ type: 'system', subtype: 'init', session_id: flag(args.includes('--resume') ? '--resume' : '--session-id') })
  const usage = { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 2 }
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg1', usage } } })
  emit({ type: 'assistant', message: { id: 'msg1', usage } })
  emit({ type: 'assistant', message: { id: 'msg1', usage } }) // Duplicate must not double charge.
  if (scenario.probe) {
    const confirm = tools.find(tool => tool.name === 'confirm')
    await rpc('tools/call', { name: 'confirm', arguments: { nonce: confirm.inputSchema.properties.nonce.enum[0] } })
  }
  for (const operation of scenario.tools || []) {
    const pending = rpc('tools/call', { name: operation.name, arguments: operation.arguments || {} })
    if (scenario.exitDuringTool) { setTimeout(() => process.exit(0), 100); await new Promise(() => {}) }
    await pending
  }
  emit({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Verified ' } } })
  emit({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'result' } } })
  if (scenario.noResult) { process.exit(0) }
  emit({ type: 'result', subtype: scenario.resultError ? 'error_during_execution' : 'success', is_error: !!scenario.resultError,
    result: scenario.resultError ? 'Usage limit reached' : 'Verified result', usage,
    session_id: scenario.wrongSession ? '00000000-0000-0000-0000-000000000000' : flag(args.includes('--resume') ? '--resume' : '--session-id') })
})().catch(error => { console.error(error.message); process.exitCode = 1 })
