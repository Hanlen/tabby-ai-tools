const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), Module = require('node:module'), ts = require('typescript')
const old = require.extensions['.ts']
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2019}}).outputText,file)
const {McpTerminalExecution}=require('../src/mcp-execution.ts')
require.extensions['.ts']=old
function fixture (t) {
 const entry={key:'key',session:'generation',terminal:{session:{open:true}}}, calls=[],released=[]
 let handler=async()=>({sent:true,tabId:'internal-id',server:{private:'internal'}})
 const tools={callTerminal:async(...args)=>{calls.push(args);return handler(...args)},releaseOwner:id=>released.push(id)}
 const adapter=new McpTerminalExecution(()=>tools)
 const grant={clientId:'client',revision:1,targetId:'target',key:'key',session:'generation',mode:'auto'}
 const lease={id:'lease',...grant,expiresAt:Date.now()+120000}
 adapter.update([entry],[grant],[lease]);t.after(()=>adapter.destroy())
 const request={...grant,leaseId:'lease',tool:'send_input',args:{text:'pwd',submit:true,mode:'command',owner:'forged',foregroundTaskNeeded:false}}
 return {adapter,entry,grant,lease,calls,released,request,setHandler:fn=>{handler=fn}}
}
test('write adapter maps only a granted terminal, strips takeover arguments and internal return fields',async t=>{
 const f=fixture(t), result=await f.adapter.execute(f.request,new AbortController().signal)
 assert.equal(f.calls[0][2],f.entry.terminal);assert.equal(f.calls[0][3].owner,'mcp:lease');assert.equal(f.calls[0][3].allowTakeover,false)
 assert.deepEqual(f.calls[0][1],{text:'pwd',submit:true,mode:'command'});assert.equal(result.tabId,undefined);assert.equal(result.server,undefined)
})
test('read-only, foreign/expired lease, stale session and control-character text never call terminal tools',async t=>{
 const f=fixture(t)
 for(const request of [{...f.request,clientId:'other'},{...f.request,leaseId:'stolen'},{...f.request,args:{text:'\x03'}}])await assert.rejects(f.adapter.execute(request,new AbortController().signal))
 f.adapter.update([f.entry],[{...f.grant,mode:'read_only'}],[f.lease]);await assert.rejects(f.adapter.execute(f.request,new AbortController().signal))
 f.adapter.update([f.entry],[f.grant],[{...f.lease,expiresAt:Date.now()-1}]);await assert.rejects(f.adapter.execute(f.request,new AbortController().signal))
 assert.equal(f.calls.length,0)
})
test('revocation during asynchronous process checks prevents send and releases only this lease',async t=>{
 const f=fixture(t);let resume,sent=0
 f.setHandler(async(_name,_args,_terminal,context)=>{await new Promise(r=>{resume=r});context.beforeInput();context.onInput();sent++;return{sent:true}})
 const pending=f.adapter.execute(f.request,new AbortController().signal)
 f.adapter.update([f.entry],[],[]);resume();await assert.rejects(pending,{code:'permission_denied'})
 assert.equal(sent,0);assert.ok(f.released.every(x=>x==='mcp:lease'))
})
test('session change after process inspection blocks input even if the opaque target did not change',async t=>{
 const f=fixture(t);let resume,sent=0
 f.setHandler(async(_n,_a,_t,c)=>{await new Promise(r=>{resume=r});c.beforeInput();sent++;return{sent:true}})
 const pending=f.adapter.execute(f.request,new AbortController().signal);f.entry.terminal.session={open:true};resume()
 await assert.rejects(pending,{code:'target_stale'});assert.equal(sent,0)
})
test('failure or revocation after a send is unknown outcome and never causes a replay',async t=>{
 const f=fixture(t);let count=0
 f.setHandler(async(_n,_a,_t,c)=>{c.beforeInput();c.onInput();count++;f.adapter.update([f.entry],[],[]);return{sent:true}})
 await assert.rejects(f.adapter.execute(f.request,new AbortController().signal),{code:'unknown_outcome'});assert.equal(count,1)
})

test('renderer lease deadline restores its own input even if main can no longer deliver release messages',async t=>{
 const f=fixture(t);await f.adapter.execute(f.request,new AbortController().signal)
 f.adapter.update([f.entry],[f.grant],[{...f.lease,expiresAt:Date.now()+15}])
 await new Promise(r=>setTimeout(r,35))
 assert.ok(f.released.includes('mcp:lease'))
 await assert.rejects(f.adapter.execute(f.request,new AbortController().signal),{code:'invalid_lease'})
 assert.equal(f.adapter.timers.size,0)
})
