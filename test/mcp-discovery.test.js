const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const {McpDiscovery}=require('../artifacts/mcp-discovery.cjs')
function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'tabby-discovery-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return{home,create:space=>new McpDiscovery(home,space,path.resolve(__dirname,'../skills/tabby-mcp'),'0.9.4')}}
test('portable skill installs into shared and existing agent directories without accounts, secrets, or Node lifecycle scripts',t=>{
 const f=fixture(t);for(const client of ['.codex','.claude','.cursor'])fs.mkdirSync(path.join(f.home,client))
 const d=f.create('one'),result=d.installSkill();assert.equal(result.length,2);assert.ok(result.every(x=>x.status==='installed'))
 assert.equal(fs.existsSync(path.join(f.home,'.codex','skills')),false);assert.equal(fs.existsSync(path.join(f.home,'.cursor','skills')),false)
 for(const entry of result){assert.match(fs.readFileSync(path.join(entry.path,'SKILL.md'),'utf8'),/name: tabby-mcp/);const locator=JSON.parse(fs.readFileSync(path.join(entry.path,'references/local-discovery.json')));assert.equal(locator.registry,d.registry);assert.equal(locator.credentialsIncluded,false)}
 assert.ok(d.installSkill().every(x=>x.status==='present'))
})
test('existing, edited and symlinked skills are preserved instead of overwritten',t=>{
 const f=fixture(t),d=f.create('one'),[entry]=d.installSkill(),file=path.join(entry.path,'SKILL.md')
 fs.writeFileSync(file,'user customization');assert.equal(d.installSkill()[0].status,'conflict');assert.equal(fs.readFileSync(file,'utf8'),'user customization')
 fs.rmSync(entry.path,{recursive:true});fs.mkdirSync(entry.path);assert.equal(d.installSkill()[0].status,'conflict')
 if(process.platform!=='win32'){fs.rmdirSync(entry.path);fs.symlinkSync(f.home,entry.path);assert.equal(d.installSkill()[0].status,'conflict');assert.ok(fs.lstatSync(entry.path).isSymbolicLink())}
})
test('discovery metadata contains only location and setup, isolates config spaces, and removes stale endpoints when disabled',t=>{
 const f=fixture(t),a=f.create('one'),b=f.create('two')
 a.update({enabled:true,running:true,endpoint:'http://127.0.0.1:48123/mcp',token:'NEVER_WRITE_THIS',clients:[{digest:'SECRET_DIGEST'}]})
 b.update({enabled:false,running:false,endpoint:''})
 const files=fs.readdirSync(a.registry);assert.equal(files.length,2);assert.notEqual(a.profile,b.profile)
 const file=path.join(a.registry,a.profile+'.json'),before=fs.readFileSync(file,'utf8');assert.ok(!before.includes('NEVER_WRITE_THIS')&&!before.includes('SECRET_DIGEST'));assert.equal(JSON.parse(before).credentialsIncluded,false)
 a.update({enabled:false,running:false,endpoint:'http://127.0.0.1:48123/mcp'});assert.equal(JSON.parse(fs.readFileSync(file)).endpoint,'')
 fs.rmSync(file);a.update({enabled:false,running:false,endpoint:''});assert.equal(JSON.parse(fs.readFileSync(file)).status,'disabled')
 if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600)
 assert.throws(()=>a.update({enabled:true,running:true,endpoint:'http://0.0.0.0:48123/mcp'}))
})
test('failed partial discovery writes clean temporary files and preserve the previous record',t=>{
 const f=fixture(t),d=f.create('one');d.update({enabled:false,running:false,endpoint:''})
 const file=path.join(d.registry,d.profile+'.json'),before=fs.readFileSync(file,'utf8'),write=fs.writeFileSync
 fs.writeFileSync=(file,data,options)=>{if(String(file).endsWith('.tmp')){write(file,'partial',options);throw Error('disk full')}return write(file,data,options)}
 try{assert.throws(()=>d.update({enabled:true,running:true,endpoint:'http://127.0.0.1:48123/mcp'}))}finally{fs.writeFileSync=write}
 assert.equal(fs.readFileSync(file,'utf8'),before);assert.deepEqual(fs.readdirSync(d.registry),[d.profile+'.json'])
})
test('discovery filesystem failure does not require access to credential files',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.home,'.agents'),'blocked');const d=f.create('one')
 assert.equal(d.installSkill()[0].status,'error');assert.throws(()=>d.update({enabled:false,running:false,endpoint:''}))
 assert.equal(fs.readFileSync(path.join(f.home,'.agents'),'utf8'),'blocked')
})
