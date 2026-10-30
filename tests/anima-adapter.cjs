const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../lib/anima.js'), 'utf8');
let passed = 0;
async function fixture() {
  const data = {
    context: {chatId:'chat-A',characterId:0,characters:[{data:{}}],chatMetadata:{anima_rag_active_files:['memory-A']},chat:[{is_user:false,mes:'开场'},{is_user:true,mes:'旧输入'}],extensionSettings:{anima_memory_system:{rag:{rag_enabled:true,vector_prompt:[{type:'context',count:5}],injection_settings:{recent_count:0}},status:{status_enabled:false}}}},
    payload:null,entries:[],queryCalls:0,nativeCalls:0,containerWrites:0,version:'3.3.6',nativeNoop:false,
    queryResult:{merged_chat_results:[],merged_kb_results:[]},variables:{},
  };
  const context = vm.createContext({URL,JSON,Date,Map,Set,Promise,Error,Number,String,Array,RegExp,AbortController,structuredClone,location:{origin:'http://localhost:8000'},fetch:async()=>({ok:true,json:async()=>({version:data.version,generate_interceptor:'Anima_RAG_Interceptor'})}),SillyTavern:{getContext:()=>data.context},TavernHelper:{getChatWorldbookName:()=> 'book',getWorldbook:async()=> data.entries,getVariables:async()=>data.variables}});
  const updateContainer = (name,content) => {data.containerWrites++;if(data.writeHook)return data.writeHook(name,content);const entry=data.entries.find(e=>e.name===name);if(entry){entry.content=content;entry.enabled=!!content;}else if(content)data.entries.push({name,content,enabled:true});};
  context.Anima_RAG_Interceptor = async()=>{data.nativeCalls++;if(!data.nativeNoop)data.payload={...structuredClone(data.queryResult),query:data.nativeQueryOverride??data.context.chat.map(m=>`${m.is_user?'user':'assistant'}: ${m.mes}`).join('\n'),bm25Query:''};await data.nativeHook?.();};
  const native = {
    'rag_logic.js': {getEffectiveSettings:()=>data.context.extensionSettings.anima_memory_system.rag,getLastRetrievalPayload:()=>data.payload,queryDual:async args=>{data.queryCalls++;data.args=args;return data.queryHook?data.queryHook():data.queryResult;}},
    'utils.js': {getSmartCollectionId:()=> 'memory-A',processMacros:text=>text,applyRegexRules:(text,rules)=>rules?.[0]?.removeAll?'':text},
    'knowledge.js':{getKbSearchPayload:()=>({kbContext:{ids:[],strategy:{}},bm25ConfigsKb:[]})},
    'bm25_logic.js':{getBm25BackendConfig:()=>({enabled:false})},
    'worldbook_api.js':{updateRagEntry:async content=>updateContainer('[ANIMA_Chat_History_Container]',content),updateKnowledgeEntry:async content=>updateContainer('[ANIMA_Knowledge_Container]',content)},
  };
  const modules = {};
  for(const [name,values] of Object.entries(native)){
    const mod = new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v] of Object.entries(values))this.setExport(k,v);},{context});
    await mod.link(()=>{});await mod.evaluate();modules[name]=mod;
  }
  const mod = new vm.SourceTextModule(source,{context,importModuleDynamically:async spec=>modules[spec.split('/').at(-1)]});
  await mod.link(()=>{});await mod.evaluate();
  return {data,global:context,api:mod.namespace,recall:opts=>mod.namespace.recallAnima({context:data.context,userInput:'新输入',settings:{inputAlreadyInChat:false},...opts})};
}
async function test(name, fn){await fn();passed++;process.stdout.write(`PASS ${name}\n`);}
(async()=>{
 await test('direct uses pending input and accepts genuine empty',async()=>{const f=await fixture();const r=await f.recall();assert.equal(r.status,'empty');assert.equal(r.memoryParts.length,0);assert.match(f.data.args.searchText,/新输入/);assert.equal(f.data.queryCalls,1);assert.equal(f.data.context.chat.length,2);});
 await test('memory metadata retains complete source blocks and survives cache reuse without mutation',async()=>{
   const f=await fixture();
   f.data.context.extensionSettings.anima_memory_system.rag.injection_settings.recent_count=1;
   f.data.context.extensionSettings.anima_memory_system.status.status_enabled=true;
   f.data.variables={anima_data:'门仍开着。'};
   f.data.entries=[{extra:{createdBy:'anima_summary',history:[{batch_id:1,slice_id:0,unique_id:'1_0',narrative_time:2}]},content:'<1_0>当前摘要</1_0>'}];
   f.data.queryResult={merged_chat_results:[{text:'原始回忆\n第二行'}],merged_kb_results:[{text:'完整知识',doc_name:'设定文档'}]};
   const first=await f.recall();
   const parts=JSON.parse(JSON.stringify(first.memoryParts));
   assert.deepEqual(parts,[
     {header:'[Anima 聊天记忆]',content:'原始回忆\n第二行'},
     {header:'[Anima 最近摘要]',content:'当前摘要'},
     {header:'[Anima 知识库]',content:'以下是相关设定：\n[Source: 设定文档]\n完整知识'},
     {header:'[Anima 当前状态]',content:'门仍开着。'},
   ]);
   assert.equal(first.text,parts.map(p=>`${p.header}\n${p.content}`).join('\n\n'));
   first.memoryParts[0].content='外部修改';
   const second=await f.recall();assert.deepEqual(JSON.parse(JSON.stringify(second.memoryParts)),parts);
   assert.equal(second.text,first.text);assert.equal(f.data.queryCalls,1);
 });
 await test('recent summary selection and exclusion use newest narrative file',async()=>{const f=await fixture();f.data.context.extensionSettings.anima_memory_system.rag.injection_settings.recent_count=1;f.data.entries=[{extra:{createdBy:'anima_summary',history:[{batch_id:9,slice_id:0,unique_id:'9_0',narrative_time:1}]},content:'<9_0>旧文件</9_0>'},{extra:{createdBy:'anima_summary',history:[{batch_id:1,slice_id:0,unique_id:'1_0',narrative_time:2}]},content:'<1_0>当前摘要</1_0>'}];const r=await f.recall();assert.match(r.text,/当前摘要/);assert.doesNotMatch(r.text,/旧文件/);assert.equal(f.data.args.excludeIds[0],'1_0');});
 await test('broken summary is failure not empty',async()=>{const f=await fixture();f.data.context.extensionSettings.anima_memory_system.rag.injection_settings.recent_count=1;f.data.entries=[{extra:{createdBy:'anima_summary',history:[{index:1}]},content:'wrong'}];await assert.rejects(f.recall(),e=>e.code==='ANIMA_SUMMARY_INVALID');assert.equal(f.data.queryCalls,0);});
 await test('fresh native capture retries reuse same round without second query',async()=>{const f=await fixture();await f.api.installAnimaObserver();const token=f.api.beginAnimaGeneration();await f.global.Anima_RAG_Interceptor([],0,null,'normal');const r=await f.recall({generationToken:token,userInput:'旧输入'});assert.equal(r.nativeAlreadyInjected,true);assert.equal(f.data.queryCalls,0);const reused=await f.recall({generationToken:token,userInput:'旧输入'});assert.equal(reused.reusedForRound,true);assert.equal(f.data.queryCalls,0);});
 await test('stale global payload is rejected if native skipped',async()=>{const f=await fixture();f.data.payload=structuredClone(f.data.queryResult);f.data.nativeNoop=true;await f.api.installAnimaObserver();const token=f.api.beginAnimaGeneration();await f.global.Anima_RAG_Interceptor([],0,null,'normal');await assert.rejects(f.recall({generationToken:token,userInput:'旧输入'}),e=>e.code==='ANIMA_QUERY_FAILED');assert.equal(f.data.queryCalls,0);});
 await test('automatic capture rejects a different input',async()=>{const f=await fixture();await f.api.installAnimaObserver();const token=f.api.beginAnimaGeneration();await f.global.Anima_RAG_Interceptor([],0,null,'normal');await assert.rejects(f.recall({generationToken:token,userInput:'另一个草稿'}),e=>e.code==='ANIMA_INPUT_CHANGED');});
 await test('native observation snapshot cannot be changed by later global payload mutation',async()=>{const f=await fixture();await f.api.installAnimaObserver();const token=f.api.beginAnimaGeneration();await f.global.Anima_RAG_Interceptor([],0,null,'normal');f.data.payload.query='unrelated';const result=await f.recall({generationToken:token,userInput:'旧输入'});assert.equal(result.status,'empty');});
 await test('automatic capture rejects unrelated concurrent query payload',async()=>{const f=await fixture();await f.api.installAnimaObserver();f.data.nativeQueryOverride='unrelated';const token=f.api.beginAnimaGeneration();await f.global.Anima_RAG_Interceptor([],0,null,'normal');await assert.rejects(f.recall({generationToken:token,userInput:'旧输入'}),e=>e.code==='ANIMA_QUERY_CHANGED');});
 await test('backend failure is never successful empty',async()=>{const f=await fixture();f.data.queryResult={_is_critical_failure:true,merged_chat_results:[],merged_kb_results:[]};await assert.rejects(f.recall(),e=>e.code==='ANIMA_QUERY_FAILED');});
 await test('RAG off reads only enabled summaries without vector query',async()=>{const f=await fixture();f.data.context.extensionSettings.anima_memory_system.rag.rag_enabled=false;f.data.entries=[{enabled:true,name:'chapter_1',extra:{createdBy:'anima_summary'},content:'有效摘要'},{enabled:false,extra:{createdBy:'anima_summary'},content:'已关闭摘要'}];const r=await f.recall();assert.match(f.data.entries[0].content,/有效摘要/);assert.equal(r.text,'[Anima 摘要：chapter_1]\n有效摘要');assert.deepEqual(JSON.parse(JSON.stringify(r.memoryParts)),[{header:'[Anima 摘要：chapter_1]',content:'有效摘要'}]);assert.doesNotMatch(r.text,/已关闭/);assert.equal(f.data.queryCalls,0);});
 await test('context switch discards results',async()=>{const f=await fixture();f.data.queryHook=()=>{f.data.context.chatId='chat-B';return f.data.queryResult;};await assert.rejects(f.recall(),e=>e.code==='ANIMA_CONTEXT_CHANGED');});
 await test('cancelled direct query preserves successful round for retry',async()=>{const f=await fixture();const controller=new AbortController();f.data.queryHook=()=>{controller.abort();return f.data.queryResult;};await assert.rejects(f.recall({signal:controller.signal}),e=>e.code==='ABORTED');const result=await f.recall();assert.equal(result.reusedForRound,true);assert.equal(f.data.queryCalls,1);});
 await test('one-shot matching guard only skips a single normal attempt',async()=>{const f=await fixture();await f.api.installAnimaObserver();f.api.skipNextAnimaRecall({matches:()=>true});await f.global.Anima_RAG_Interceptor([],0,null,'normal');assert.equal(f.data.nativeCalls,0);await f.global.Anima_RAG_Interceptor([],0,null,'normal');assert.equal(f.data.nativeCalls,1);});
 await test('nonmatching guard is consumed and native keeps running',async()=>{const f=await fixture();await f.api.installAnimaObserver();let yes=false;f.api.skipNextAnimaRecall({matches:()=>yes});await f.global.Anima_RAG_Interceptor([],0,null,'normal');yes=true;await f.global.Anima_RAG_Interceptor([],0,null,'normal');assert.equal(f.data.nativeCalls,2);});
 await test('explicit swipe guard skips exactly one matching fixed-reply attempt',async()=>{
   const f=await fixture();await f.api.installAnimaObserver();
   const reply={is_user:false,mes:'已生成正文',swipes:['已生成正文'],swipe_id:1};f.data.context.chat.push(reply);
   const prefix=JSON.stringify(f.data.context.chat.slice(0,-1));
   f.api.skipNextAnimaRecall({type:'swipe',matches:()=>f.data.context.chat.at(-1)===reply&&JSON.stringify(f.data.context.chat.slice(0,-1))===prefix});
   const aborted=[];await f.global.Anima_RAG_Interceptor(f.data.context.chat.slice(0,-1),0,value=>aborted.push(value),'swipe');
   assert.equal(f.data.nativeCalls,0);assert.equal(f.data.queryCalls,0);assert.deepEqual(aborted,[]);
   await f.global.Anima_RAG_Interceptor([],0,null,'swipe');assert.equal(f.data.nativeCalls,1);
 });
 await test('nonmatching swipe proof aborts without native recall and cannot skip a later attempt',async()=>{
   const f=await fixture();await f.api.installAnimaObserver();const aborted=[];
   f.api.skipNextAnimaRecall({type:'swipe',matches:()=>false});
   await assert.rejects(f.global.Anima_RAG_Interceptor([],0,value=>aborted.push(value),'swipe'),e=>e.code==='ANIMA_REUSE_GUARD');
   assert.deepEqual(aborted,[true]);assert.equal(f.data.nativeCalls,0);
   await f.global.Anima_RAG_Interceptor([],0,null,'swipe');assert.equal(f.data.nativeCalls,1);
 });
 await test('swipe proof requires literal true and aborts on synchronous or asynchronous errors',async()=>{
   for(const matches of [()=> 'true',()=>1,()=>undefined,()=>{throw new Error('guard failed');},async()=>{throw new Error('guard failed');}]){
     const f=await fixture();await f.api.installAnimaObserver();const aborted=[];
     f.api.skipNextAnimaRecall({type:'swipe',matches});
     await assert.rejects(f.global.Anima_RAG_Interceptor([],0,value=>aborted.push(value),'swipe'),e=>e.code==='ANIMA_REUSE_GUARD');
     assert.deepEqual(aborted,[true]);assert.equal(f.data.nativeCalls,0);
     await f.global.Anima_RAG_Interceptor([],0,null,'swipe');assert.equal(f.data.nativeCalls,1);
   }
 });
 await test('swipe proof cannot authorize a context that changes while the match is awaited',async()=>{
   const f=await fixture();await f.api.installAnimaObserver();const aborted=[];
   f.api.skipNextAnimaRecall({type:'swipe',matches:async()=>{await Promise.resolve();f.data.context.chatId='chat-B';return true;}});
   await assert.rejects(f.global.Anima_RAG_Interceptor([],0,value=>aborted.push(value),'swipe'),e=>e.code==='ANIMA_REUSE_GUARD');
   assert.deepEqual(aborted,[true]);assert.equal(f.data.nativeCalls,0);
 });
 await test('a different generation type discards an explicit swipe guard without suppressing native recall',async()=>{
   for(const type of ['normal','chat',undefined,'quiet']){
     const f=await fixture();await f.api.installAnimaObserver();let checked=0;const aborted=[];
     f.api.skipNextAnimaRecall({type:'swipe',matches:()=>{checked++;return true;}});
     await f.global.Anima_RAG_Interceptor([],0,value=>aborted.push(value),type);
     await f.global.Anima_RAG_Interceptor([],0,value=>aborted.push(value),'swipe');
     assert.equal(checked,0);assert.equal(f.data.nativeCalls,2);assert.deepEqual(aborted,[]);
   }
 });
 await test('default guard still ignores swipe and accepts normal chat or unspecified generation',async()=>{
   for(const type of ['normal','chat',undefined]){
     const f=await fixture();await f.api.installAnimaObserver();let checked=0;
     f.api.skipNextAnimaRecall({matches:()=>{checked++;return true;}});
     await f.global.Anima_RAG_Interceptor([],0,null,'swipe');assert.equal(f.data.nativeCalls,1);assert.equal(checked,0);
     await f.global.Anima_RAG_Interceptor([],0,null,type);assert.equal(f.data.nativeCalls,1);assert.equal(checked,1);
   }
 });
 await test('default guard exceptions retain native fallback without aborting',async()=>{
   const f=await fixture();await f.api.installAnimaObserver();const aborted=[];
   f.api.skipNextAnimaRecall({matches:()=>{throw new Error('old guard failed');}});
   await f.global.Anima_RAG_Interceptor([],0,value=>aborted.push(value),'normal');
   assert.equal(f.data.nativeCalls,1);assert.deepEqual(aborted,[]);
 });
 await test('disposing a cancelled swipe guard restores native recall without clearing a newer guard',async()=>{
   const f=await fixture();await f.api.installAnimaObserver();
   const cancelled=f.api.skipNextAnimaRecall({type:'swipe',matches:()=>true});cancelled();
   await f.global.Anima_RAG_Interceptor([],0,null,'swipe');assert.equal(f.data.nativeCalls,1);
   const older=f.api.skipNextAnimaRecall({type:'swipe',matches:()=>true});
   f.api.skipNextAnimaRecall({type:'swipe',matches:()=>true});older();
   await f.global.Anima_RAG_Interceptor([],0,null,'swipe');assert.equal(f.data.nativeCalls,1);
   await f.global.Anima_RAG_Interceptor([],0,null,'swipe');assert.equal(f.data.nativeCalls,2);
 });
 await test('disposing during an awaited swipe proof aborts the pending attempt',async()=>{
   const f=await fixture();await f.api.installAnimaObserver();let finish,started;const began=new Promise(resolve=>{started=resolve;});const aborted=[];
   const dispose=f.api.skipNextAnimaRecall({type:'swipe',matches:()=>new Promise(resolve=>{finish=resolve;started();})});
   const pending=f.global.Anima_RAG_Interceptor([],0,value=>aborted.push(value),'swipe');
   await began;dispose();finish(true);
   await assert.rejects(pending,e=>e.code==='ANIMA_REUSE_GUARD');assert.deepEqual(aborted,[true]);assert.equal(f.data.nativeCalls,0);
   await f.global.Anima_RAG_Interceptor([],0,null,'swipe');assert.equal(f.data.nativeCalls,1);
 });
 await test('missing helper cannot masquerade as no memories',async()=>{const f=await fixture();delete f.global.TavernHelper;await assert.rejects(f.recall(),e=>e.code==='ANIMA_HELPER_REQUIRED');});
 await test('unreviewed version is rejected before native import/query',async()=>{const f=await fixture();f.data.version='2.0';await assert.rejects(f.recall(),e=>e.code==='ANIMA_VERSION');assert.equal(f.data.queryCalls,0);});
 await test('regex deleting current input rejects old-history-only query',async()=>{const f=await fixture();f.data.context.extensionSettings.anima_memory_system.rag.regex_strings=[{removeAll:true}];await assert.rejects(f.recall(),e=>e.code==='ANIMA_EMPTY_QUERY');});
 await test('manual planning retry preserves exact Echo text and queries once',async()=>{const f=await fixture();f.data.queryResult={merged_chat_results:[{text:'保留中的重要记忆',is_echo:true}],merged_kb_results:[]};const first=await f.recall();f.data.queryResult.merged_chat_results[0].text='changed';const second=await f.recall();assert.equal(first.text,second.text);assert.equal(second.reusedForRound,true);assert.equal(f.data.queryCalls,1);});
 await test('manual to automatic normalized round skips native and makes fresh observation',async()=>{const f=await fixture();await f.api.installAnimaObserver();const first=await f.recall();f.data.context.chat.push({is_user:true,mes:'新输入',name:'User'});const token=f.api.beginAnimaGeneration();await f.global.Anima_RAG_Interceptor([],0,null,'normal');const second=await f.recall({generationToken:token,settings:{inputAlreadyInChat:true}});assert.equal(second.text,first.text);assert.equal(second.reusedForRound,true);assert.equal(second.nativeAlreadyInjected,false);assert.equal(f.data.queryCalls,1);assert.equal(f.data.nativeCalls,0);});
 await test('cancelled automatic generation reuses recall on a new generation',async()=>{const f=await fixture();await f.api.installAnimaObserver();let token=f.api.beginAnimaGeneration();await f.global.Anima_RAG_Interceptor([],0,null,'normal');f.api.clearAnimaGeneration(token);token=f.api.beginAnimaGeneration();await f.global.Anima_RAG_Interceptor([],0,null,'normal');const r=await f.recall({generationToken:token,userInput:'旧输入'});assert.equal(r.reusedForRound,true);assert.equal(f.data.nativeCalls,1);assert.equal(f.data.queryCalls,0);});
 await test('cancellation during native await preserves successful raw recall',async()=>{const f=await fixture();await f.api.installAnimaObserver();let token=f.api.beginAnimaGeneration();f.data.nativeHook=()=>f.api.clearAnimaGeneration(token);await f.global.Anima_RAG_Interceptor([],0,null,'normal');delete f.data.nativeHook;token=f.api.beginAnimaGeneration();await f.global.Anima_RAG_Interceptor([],0,null,'normal');await f.recall({generationToken:token,userInput:'旧输入'});assert.equal(f.data.nativeCalls,1);});
 await test('invalidating after committed writer reply requires new recall',async()=>{const f=await fixture();await f.recall();f.api.invalidateAnimaRoundCache();await f.recall();assert.equal(f.data.queryCalls,2);});
 await test('new assistant history makes identical user text a new round',async()=>{const f=await fixture();await f.recall();f.data.context.chat.push({is_user:false,mes:'新正文'});await f.recall();assert.equal(f.data.queryCalls,2);});
 await test('changed Anima retention settings create a new key without alteration',async()=>{const f=await fixture();f.data.context.extensionSettings.anima_memory_system.rag.imp_life=7;await f.recall();f.data.context.extensionSettings.anima_memory_system.rag.imp_life=8;await f.recall();assert.equal(f.data.queryCalls,2);assert.equal(f.data.context.extensionSettings.anima_memory_system.rag.imp_life,8);});
 await test('changed planner configuration does not change Anima round',async()=>{const f=await fixture();await f.recall();f.data.context.extensionSettings.plot_workshop={model:'another'};await f.recall();assert.equal(f.data.queryCalls,1);});
 await test('observer never auto-skips when plugin generation is not active',async()=>{const f=await fixture();await f.api.installAnimaObserver();const token=f.api.beginAnimaGeneration();await f.global.Anima_RAG_Interceptor([],0,null,'normal');await f.recall({generationToken:token,userInput:'旧输入'});f.api.clearAnimaGeneration(token);await f.global.Anima_RAG_Interceptor([],0,null,'normal');assert.equal(f.data.nativeCalls,2);});
 await test('changed input creates a new recall, no arbitrary old payload fallback',async()=>{const f=await fixture();await f.recall();await f.recall({userInput:'更改后的输入'});assert.equal(f.data.queryCalls,2);});
 await test('manual query refreshes stale native worldbook containers before return',async()=>{const f=await fixture();f.data.entries=[{name:'[ANIMA_Chat_History_Container]',content:'上轮记忆',enabled:true},{name:'[ANIMA_Knowledge_Container]',content:'上轮知识',enabled:true}];f.data.queryResult={merged_chat_results:[{text:'本轮重要记忆',is_echo:true}],merged_kb_results:[{text:'本轮知识',doc_name:'设定'}]};const r=await f.recall();assert.equal(r.dynamicContainersReady,true);assert.equal(f.data.entries[0].content,'本轮重要记忆');assert.equal(f.data.entries[1].content,'以下是相关设定：\n[Source: 设定]\n本轮知识');assert.equal(f.data.containerWrites,2);await f.recall();assert.equal(f.data.containerWrites,2);assert.equal(f.data.queryCalls,1);});
 await test('genuine empty retrieval clears only old dynamic content',async()=>{const f=await fixture();f.data.entries=[{name:'[ANIMA_Chat_History_Container]',content:'旧记忆',enabled:true},{name:'[ANIMA_Knowledge_Container]',content:'旧知识',enabled:true},{name:'普通条目',content:'保留'}];await f.recall();assert.equal(f.data.entries[0].content,'');assert.equal(f.data.entries[1].content,'');assert.equal(f.data.entries[2].content,'保留');});
 await test('failed container write stops planning but successful recall is retained',async()=>{const f=await fixture();f.data.queryResult={merged_chat_results:[{text:'新记忆'}],merged_kb_results:[]};f.data.writeHook=()=>{throw new Error('failure');};await assert.rejects(f.recall(),e=>e.code==='ANIMA_CONTAINER_WRITE');delete f.data.writeHook;await f.recall();assert.equal(f.data.queryCalls,1);assert.equal(f.data.entries[0].content,'新记忆');});
 await test('silent official writer failure is detected by readback',async()=>{const f=await fixture();f.data.queryResult={merged_chat_results:[{text:'新记忆'}],merged_kb_results:[]};f.data.writeHook=()=>{};await assert.rejects(f.recall(),e=>e.code==='ANIMA_CONTAINER_VERIFY');});
 await test('context switch during container write stops later writes and planning',async()=>{const f=await fixture();f.data.queryResult={merged_chat_results:[{text:'新记忆'}],merged_kb_results:[{text:'知识'}]};f.data.writeHook=()=>{f.data.context.chatId='different';};await assert.rejects(f.recall(),e=>e.code==='ANIMA_CONTEXT_CHANGED');assert.equal(f.data.containerWrites,1);});
 await test('native generation cannot overlap an unfinished manual recall',async()=>{const f=await fixture();await f.api.installAnimaObserver();let finish, started;const began=new Promise(resolve=>{started=resolve;});f.data.queryHook=()=>new Promise(resolve=>{finish=resolve;started();});const pending=f.recall();await began;f.api.beginAnimaGeneration();await assert.rejects(f.global.Anima_RAG_Interceptor([],0,null,'normal'),e=>e.code==='ANIMA_BUSY');finish(f.data.queryResult);await pending;assert.equal(f.data.nativeCalls,0);assert.equal(f.data.queryCalls,1);});
 await test('ordinary send explicitly aborts during manual recall even if host swallows errors',async()=>{const f=await fixture();await f.api.installAnimaObserver();let finish,started;const began=new Promise(resolve=>{started=resolve;});f.data.queryHook=()=>new Promise(resolve=>{finish=resolve;started();});const pending=f.recall();await began;const abortArgs=[];try{await f.global.Anima_RAG_Interceptor([],0,value=>abortArgs.push(value),'normal');}catch(e){assert.equal(e.code,'ANIMA_BUSY');/* Simulate ST logging and swallowing this error. */}assert.deepEqual(abortArgs,[true]);assert.equal(f.data.nativeCalls,0);finish(f.data.queryResult);await pending;await f.global.Anima_RAG_Interceptor([],0,value=>abortArgs.push(value),'normal');assert.deepEqual(abortArgs,[true]);assert.equal(f.data.nativeCalls,1);});
 await test('operation marker covers direct query and complete dynamic write then clears',async()=>{const f=await fixture();assert.equal(f.api.isAnimaMemoryOperationInFlight(),false);f.data.queryResult={merged_chat_results:[{text:'新记忆'}],merged_kb_results:[]};f.data.queryHook=()=>{assert.equal(f.api.isAnimaMemoryOperationInFlight(),true);return f.data.queryResult;};f.data.writeHook=async(name,content)=>{assert.equal(f.api.isAnimaMemoryOperationInFlight(),true);await Promise.resolve();assert.equal(f.api.isAnimaMemoryOperationInFlight(),true);f.data.entries.push({name,content,enabled:true});};await f.recall();assert.equal(f.api.isAnimaMemoryOperationInFlight(),false);});
 await test('operation marker spans complete native interceptor including awaited work',async()=>{const f=await fixture();await f.api.installAnimaObserver();f.data.nativeHook=async()=>{assert.equal(f.api.isAnimaMemoryOperationInFlight(),true);await Promise.resolve();assert.equal(f.api.isAnimaMemoryOperationInFlight(),true);};const token=f.api.beginAnimaGeneration();await f.global.Anima_RAG_Interceptor([],0,null,'normal');assert.equal(f.api.isAnimaMemoryOperationInFlight(),false);await f.recall({generationToken:token,userInput:'旧输入'});assert.equal(f.api.isAnimaMemoryOperationInFlight(),false);});
 await test('failed dynamic write releases operation marker in finally',async()=>{const f=await fixture();f.data.queryResult={merged_chat_results:[{text:'新记忆'}],merged_kb_results:[]};f.data.writeHook=()=>{assert.equal(f.api.isAnimaMemoryOperationInFlight(),true);throw new Error('write failed');};await assert.rejects(f.recall(),e=>e.code==='ANIMA_CONTAINER_WRITE');assert.equal(f.api.isAnimaMemoryOperationInFlight(),false);});
 process.stdout.write(`${passed} tests passed; no external requests.\n`);
})().catch(e=>{console.error(e);process.exitCode=1;});
