import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createServer } from "node:net";
import { zipSync } from "fflate";

test("set import recovery retains master and attachments across server restart", {timeout:180000}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(),"demolition-import-"));
  const listener=createServer(); listener.listen(0,"127.0.0.1"); await once(listener,"listening");
  const port=listener.address().port; await new Promise(resolve=>listener.close(resolve));
  const serverPath=new URL("../server/index.mjs",import.meta.url).pathname;
  let child;
  async function start() {
    child=spawn(process.execPath,[serverPath],{cwd:directory,env:{...process.env,DEMOLITION_DATABASE_PATH:path.join(directory,"library.sqlite"),DEMOLITION_API_PORT:String(port),DEMOLITION_API_HOST:"127.0.0.1",DEMOLITION_PROXY_TOKEN:"test-token"},stdio:["ignore","pipe","pipe"]});
    await new Promise((resolve,reject)=>{child.stdout.on("data",data=>{if(String(data).includes("Local SQLite API running"))resolve();});child.once("error",reject);child.once("exit",code=>reject(new Error("Server exited "+code)));});
  }
  async function stop(){const exited=once(child,"exit");child.kill("SIGTERM");await exited;}
  async function request(url,method="GET",body,headers={}) {
    const response=await fetch("http://127.0.0.1:"+port+url,{method,headers:{"X-Demolition-Proxy-Token":"test-token",...(body && !(body instanceof Uint8Array)?{"content-type":"application/json"}:{}),...headers},body:body instanceof Uint8Array?body:body?JSON.stringify(body):undefined});
    assert.ok(response.ok, await response.clone().text());return response;
  }
  // One second of valid mono PCM, not a user audio file.
  const wav=new Uint8Array(44+16000),view=new DataView(wav.buffer);
  function text(offset,value){for(let i=0;i<value.length;i++)wav[offset+i]=value.charCodeAt(i);}
  text(0,"RIFF");view.setUint32(4,wav.length-8,true);text(8,"WAVEfmt ");view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,8000,true);view.setUint32(28,16000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,"data");view.setUint32(40,16000,true);
  await start();
  try {
    const state=await (await request("/api/state")).json();
    state.demos=[{id:1,uuid:"import-demo",ownerId:state.account.id,title:"Import fixture",bpm:120,key:"C",duration:"00:01",status:"unheard",tags:[],note:"",nextAction:"",project:"Unsorted",updatedAt:1}];
    await request("/api/state","PUT",state);
    await request("/api/audio/1","POST",wav,{"x-file-name":"master.wav"});
    const payload={label:"Set import",notes:"Fixture",importKey:"a".repeat(64)+":"};
    const version=await (await request("/api/demos/import-demo/file-versions","POST",payload)).json();
    await request("/api/demos/import-demo/attachments?kind=stem&version="+version.id,"POST",wav,{"x-file-name":"drums.wav"});
    const project=zipSync({"Project/session.als":new TextEncoder().encode("test project")});
    await request("/api/demos/import-demo/attachments?kind=project&version="+version.id,"POST",project,{"x-file-name":"project.zip"});
    await stop();await start();
    const retry=await (await request("/api/demos/import-demo/file-versions","POST",payload)).json();
    assert.equal(retry.id,version.id);
    assert.equal((await (await request("/api/demos/import-demo/file-versions")).json()).filter(v=>v.import_key===payload.importKey).length,1);
    const files=(await (await request("/api/demos/import-demo/attachments")).json()).filter(file=>file.version_id===version.id);
    assert.equal(files.filter(file=>file.kind==="stem").length,1);
    assert.equal(files.filter(file=>file.kind==="master").length,1);
    for(const file of files) {
      assert.equal(file.version_id,version.id);
      const response=await request("/api/attachments/"+file.id+(file.kind==="project"?"":"?play=1"));
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()),file.kind==="project"?project:wav);
    }
    assert.deepEqual(new Uint8Array(await (await request("/api/audio/1")).arrayBuffer()),wav);
    if (process.env.DEMOLITION_TEST_SET_FOLDER) {
      const {transpileModule,ModuleKind,ScriptTarget}=await import("typescript");
      const source=await readFile(new URL("../app/set-files.ts",import.meta.url),"utf8");
      const js=transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText.replaceAll('from "fflate"',"from "+JSON.stringify(import.meta.resolve("fflate")));
      const {scanSets,archiveProject,setFingerprint}=await import("data:text/javascript;base64,"+Buffer.from(js).toString("base64"));
      const root=process.env.DEMOLITION_TEST_SET_FOLDER,files=[];
      async function crawl(folder) {for(const entry of await readdir(folder,{withFileTypes:true})) {const full=path.join(folder,entry.name);if(entry.isDirectory())await crawl(full);else if(entry.isFile()){const file=new File([await readFile(full)],entry.name);Object.defineProperty(file,"webkitRelativePath",{value:path.basename(root)+"/"+path.relative(root,full).split(path.sep).join("/")});files.push(file);}}}
      await crawl(root); const sets=scanSets(files,true);
      assert.ok(sets.length>0);
      const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
      for(const [index,set] of sets.entries()) {
        assert.ok(set.masters.length>0,"Missing master in real set");assert.ok(set.stems.length>0,"Missing stems in real set");assert.ok(set.project.some(f=>f.name.endsWith(".als")),"Missing Ableton project");
        const id=index+100,uuid="real-set-"+index,state=await (await request("/api/state")).json();
        state.demos.push({...state.demos[0],id,uuid,title:"Real set fixture "+index});await request("/api/state","PUT",state);
        const master=new Uint8Array(await set.masters[0].arrayBuffer());
        await request("/api/audio/"+id,"POST",master,{"x-file-name":encodeURIComponent(set.masters[0].name)});
        const key=await setFingerprint(set)+":";
        const body={label:"Real set import",notes:"Temporary validation",importKey:key};
        const version=await (await request("/api/demos/"+uuid+"/file-versions","POST",body)).json();
        for(const stem of set.stems)await request("/api/demos/"+uuid+"/attachments?kind=stem&version="+version.id,"POST",new Uint8Array(await stem.arrayBuffer()),{"x-file-name":encodeURIComponent(stem.name)});
        const archive=await archiveProject(set,true);
        await request("/api/demos/"+uuid+"/attachments?kind=project&version="+version.id,"POST",new Uint8Array(await archive.arrayBuffer()),{"x-file-name":encodeURIComponent(archive.name)});
        await stop();await start();
        assert.equal((await (await request("/api/demos/"+uuid+"/file-versions","POST",body)).json()).id,version.id);
        const saved=(await (await request("/api/demos/"+uuid+"/attachments")).json()).filter(f=>f.version_id===version.id);
        assert.equal(saved.filter(f=>f.kind==="stem").length,set.stems.length);
        for(const file of saved) {
          const original=file.kind==="master"?master:new Uint8Array(await (file.kind==="project"?archive:set.stems.find(f=>f.name===file.name)).arrayBuffer());
          const downloaded=new Uint8Array(await (await request("/api/attachments/"+file.id+(file.kind==="project"?"":"?play=1"))).arrayBuffer());
          assert.equal(digest(downloaded),digest(original));
        }
        console.log("Real set "+(index+1)+": master, "+set.stems.length+" stems, "+set.project.length+" project files verified after restart.");
      }
    }
  } finally {await stop();}
});
