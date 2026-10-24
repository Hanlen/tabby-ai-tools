const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const { spawn, spawnSync } = require('node:child_process')
const { Subject } = require('rxjs')
class Terminal {}
const load = Module._load, extension = require.extensions['.ts']
Module._load = function (request, ...args) {
  if (request === '@angular/core') return { Injectable: () => target => target }
  if (request === 'tabby-core') return { SplitTabComponent: class {} }
  if (request === 'tabby-terminal') return { BaseTerminalTabComponent: Terminal }
  if (request === 'tabby-settings') return {}
  return load.call(this, request, ...args)
}
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
}).outputText, file)
const { TabbyTabToolsService } = require('../src/tab-tools.ts')
Module._load = load; require.extensions['.ts'] = extension

const available = process.platform === 'linux' && ['script', 'bash', 'less'].every(name => spawnSync('which', [name], { stdio: 'ignore' }).status === 0)
test('real Linux PTY bash/less stays operable with unavailable enumeration and releases on command completion', { skip: available ? false : 'Requires Linux util-linux script, bash and less; not a Tabby/SSH E2E test', timeout: 10000 }, async t => {
  // Bash versions may discard an inherited PS1. Set the fixture's prompt in a
  // private rc file so the test does not depend on the runner's Bash defaults.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-pty-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const rcfile = path.join(directory, 'bashrc')
  fs.writeFileSync(rcfile, "PS1='PTY_PROMPT> '\n")
  const quotedRcfile = "'" + rcfile.replace(/'/g, "'\\''") + "'"
  const child = spawn('script', ['-qefc', `stty rows 24 cols 80; exec bash --noprofile --rcfile ${quotedRcfile} -i`, '/dev/null'], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color', LESS: '', PS0: '\x1b]133;C\x07', PROMPT_COMMAND: "printf '\\033]133;D;0\\007\\033]133;A\\007'" },
  })
  const terminal = new Terminal()
  const session = { open: true, output$: new Subject(), closed$: new Subject(), getChildProcesses: async () => [] }
  Object.assign(terminal, { title: 'Real local PTY / simulated SSH enumeration', profile: { type: 'ssh' }, session, sessionChanged$: new Subject(),
    sendInput: text => child.stdin.write(text), frontend: { xterm: { buffer: { active: { type: 'normal' } } } } })
  let output = ''
  child.stdout.on('data', chunk => {
    const text = chunk.toString()
    output += text
    // This test has no xterm renderer: expose only its alternate-buffer flag.
    if (text.includes('\x1b[?1049h')) terminal.frontend.xterm.buffer.active.type = 'alternate'
    if (text.includes('\x1b[?1049l')) terminal.frontend.xterm.buffer.active.type = 'normal'
    session.output$.next(text)
  })
  child.on('exit', () => { session.open = false; session.closed$.next() })
  const tools = new TabbyTabToolsService({ tabs: [terminal], tabsChanged$: new Subject(), activeTabChange$: new Subject() },
    { watch () {}, unwatch () {}, cursor: () => output.length, readSince: (_tab, start) => ({ text: output.slice(start), truncated: false }) })
  t.after(async () => {
    tools.ngOnDestroy()
    child.stdin.write('\x03exit\r')
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} resolve() }, 1000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  })
  const waitFor = async predicate => {
    for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
    assert.fail('PTY did not reach expected state: ' + JSON.stringify(output.slice(-1500)))
  }
  await waitFor(() => output.includes('PTY_PROMPT> '))
  const tabId = (await tools.call('list_tabs', {}))[0].id
  const context = { owner: 'pty-task' }
  assert.equal((await tools.call('send_input', { tabId, text: "printf 'pager fixture\\n' | less", submit: true }, context)).userInputLocked, true)
  await waitFor(() => output.includes('(END)'))
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.ok(tools.getControl(context.owner))
  assert.equal((await tools.call('read_tab', { tabId, waitMs: 0 })).runningProcesses, null)
  await tools.call('send_input', { tabId, mode: 'stdin', text: 'q', submit: false }, context)
  await waitFor(() => !tools.getControl(context.owner))
  assert.equal(terminal.frontend.xterm.buffer.active.type, 'normal')
  const before = output.length
  await tools.call('send_input', { tabId, text: 'sleep 0.3; printf "REAL_COMMAND_FINISHED\\n"', submit: true }, context)
  assert.ok(tools.getControl(context.owner))
  await waitFor(() => !tools.getControl(context.owner))
  assert.match(output.slice(before), /REAL_COMMAND_FINISHED/)
  await tools.call('send_input', { tabId, text: 'sleep 0.1; read -r answer; printf "READ_RESULT=%s\\n" "$answer"', submit: true }, context)
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.ok(tools.getControl(context.owner), 'a shell builtin is still waiting without child processes')
  await tools.call('send_input', { tabId, mode: 'stdin', text: 'fixture-answer', submit: true }, context)
  await waitFor(() => !tools.getControl(context.owner))
  assert.match(output, /READ_RESULT=fixture-answer/)
  assert.equal(session.open, true)
})
