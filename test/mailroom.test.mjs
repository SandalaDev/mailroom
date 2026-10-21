import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POLICY, questions, validateAnswers, decide, parseMessage, ruleDecision } from '../core.mjs';
import { Store } from '../store.mjs';
import { Providers, Runner, SecretStore } from '../providers.mjs';
import { createApp } from '../server.mjs';
import { loadExamples } from '../demo.mjs';

const policy=structuredClone(DEFAULT_POLICY);
function answer(overrides={}) {
  const selected={category:'notification',destination:'archive',urgency:'can-wait',action:'no',deadline:'no',context:'yes',retention:'no',...overrides};
  const answers={};for(const [k,q] of Object.entries(questions())){const opts=Object.keys(q.criteria);answers[k]={type:'choice',choice:selected[k],probabilities:Object.fromEntries(opts.map(o=>[o,o===selected[k]?0.995:0.005/(opts.length-1)])),confidence:.99};}
  return {result:{answers,usage:{input_tokens:123,output_tokens:0}}};
}
function message(id='abc123'){return {id,threadId:'thread1',sender:'Example <hello@example.test>',to:'me@example.test',subject:'Export completed',body:'Your export is ready.',snippet:'Your export is ready.',receivedAt:new Date().toISOString(),labels:['INBOX','UNREAD','custom'],hasAttachment:false,incomplete:false};}
function setup(t){const dir=mkdtempSync(join(tmpdir(),'mailroom-test-'));const store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,dir};}

test('clear routine notification can be proposed for archive',()=>{assert.equal(decide(message(),validateAnswers(answer()),policy).destination,'archive');});
test('action requests cannot be hidden even when Clef recommends archive',()=>{const d=decide(message(),validateAnswers(answer({action:'yes'})),policy);assert.equal(d.destination,'review');assert.ok(d.reasons.includes('possible_action'));});
test('financial records and security mail are retained despite a confident holding choice',()=>{for(const category of ['financial','security'])assert.equal(decide(message(),validateAnswers(answer({category,destination:'holding'})),policy).destination,'review');});
test('unread attachments and incomplete messages cannot be hidden',()=>{for(const flag of ['hasAttachment','incomplete'])assert.equal(decide({...message(),[flag]:true},validateAnswers(answer()),policy).destination,'review');});
test('probability ties escalate instead of exploiting option order',()=>{const raw=answer();raw.result.answers.destination.probabilities={archive:.5,review:.5,digest:0,'needs-you':0,holding:0};assert.equal(decide(message(),validateAnswers(raw),policy).destination,'review');});
test('untrusted arbitrary action, NaN, missing fields and inconsistent winners are rejected',()=>{
  const cases=[];let a=answer();a.result.answers.destination.choice='permanently-delete';cases.push(a);
  a=answer();a.result.answers.destination.probabilities.archive=NaN;cases.push(a);
  a=answer();delete a.result.answers.action;cases.push(a);
  a=answer();a.result.answers.destination.choice='holding';cases.push(a);
  a=answer();a.result.answers.destination.probabilities.execute_shell=1;cases.push(a);
  for(const c of cases)assert.throws(()=>validateAnswers(c));
});
test('MIME parsing prefers text, never executes HTML and flags attachments',()=>{
  const m=parseMessage({id:'mime',threadId:'t',internalDate:'1700000000000',labelIds:['INBOX','UNREAD'],payload:{headers:[{name:'Subject',value:'Test'}],parts:[{mimeType:'text/html',body:{data:Buffer.from('<script>steal()</script><b>Hello</b>').toString('base64url')}},{mimeType:'application/pdf',filename:'invoice.pdf',body:{attachmentId:'x',size:100}}]}});
  assert.equal(m.body,'Hello');assert.equal(m.hasAttachment,true);assert.deepEqual(m.labels,['INBOX','UNREAD']);
});
test('security code content is redacted from the compact Codex queue',t=>{const {store}=setup(t);store.add({...message(),securityHint:true,snippet:'Your code is 123456'});store.classified('abc123',{destination:'needs-you',category:'security'},1);assert.ok(!JSON.stringify(store.queue()).includes('123456'));});
test('sender rules cannot hide an important sender or obvious protected records',()=>{
  const p={...policy,importantSenders:['hello@example.test'],unwantedSenders:[]};assert.equal(ruleDecision(message(),p).destination,'needs-you');
  p.importantSenders=[];p.unwantedSenders=['hello@example.test'];assert.equal(ruleDecision({...message(),protectedHint:true},p),null);assert.equal(ruleDecision(message(),p).destination,'holding');
});
test('duplicate ingestion and new replies are independent; original labels remain intact',t=>{const {store}=setup(t);assert.equal(store.add(message()),true);assert.equal(store.add(message()),false);assert.equal(store.add(message('reply2')),true);assert.equal(store.rows().length,2);assert.deepEqual(store.row('abc123').envelope.labels,['INBOX','UNREAD','custom']);});
test('observe mode rejects archive receipts, and no delete operation exists',t=>{const {store}=setup(t);store.add(message());store.classified('abc123',{destination:'archive'},1);const revision=store.revision(store.row('abc123'));assert.throws(()=>store.acknowledge({id:'abc123',revision,kind:'archived',receipt:'provider-confirmed'}),/not permitted/);assert.throws(()=>store.acknowledge({id:'abc123',revision,kind:'deleted',receipt:'provider-confirmed'}),/not allowed/);});
test('confirmed actions deduplicate and stale decisions cannot be acknowledged',t=>{
  const {store}=setup(t);store.set('policy',{...policy,mode:'organize'});store.add(message());store.classified('abc123',{destination:'archive'},1);
  const payload={id:'abc123',revision:store.revision(store.row('abc123')),kind:'archived',receipt:'Gmail confirmed archive'};
  assert.equal(store.acknowledge(payload).recorded,true);assert.equal(store.acknowledge(payload).recorded,false);
  store.correct('abc123','needs-you');assert.throws(()=>store.acknowledge(payload),/Stale decision/);
});
test('changing policy blocks old mailbox decisions until re-reviewed',t=>{const {store}=setup(t);store.add(message());store.classified('abc123',{destination:'archive'},1);store.set('policy',{...policy,version:2,mode:'organize'});assert.equal(store.queue()[0].stalePolicy,true);assert.throws(()=>store.acknowledge({id:'abc123',revision:store.revision(store.row('abc123')),kind:'archived',receipt:'provider-confirmed'}),/Policy changed/);store.correct('abc123','archive');assert.equal(store.queue()[0].stalePolicy,false);});
test('manual corrections survive a delayed classifier result',t=>{const {store}=setup(t);store.add(message());store.correct('abc123','needs-you');store.classified('abc123',{destination:'archive'},1);assert.equal(store.row('abc123').decision.destination,'needs-you');});
test('classification failure retains message and retries later',async t=>{const {store}=setup(t);store.add(message());const runner=new Runner(store,{connectionStatus:()=>({gmail:true,cloudflare:true}),sync:async()=>{},context:async()=>[],classify:async()=>{throw new Error('bad provider');}});const r=await runner.run();assert.equal(r.failed,1);assert.equal(store.row('abc123').status,'pending');assert.ok(store.row('abc123').next_retry);assert.equal(store.pending().length,0);assert.equal(store.stats().lastRun.ok,0);});
test('runner uses one Clef result for routing without any Gmail mutations',async t=>{const {store}=setup(t);store.add(message());let calls=0;const runner=new Runner(store,{connectionStatus:()=>({gmail:true,cloudflare:true}),sync:async()=>{},context:async()=>[],classify:async()=>{calls++;return validateAnswers(answer());}});await runner.run();await runner.run();assert.equal(calls,1);assert.equal(store.row('abc123').decision.destination,'archive');assert.deepEqual(store.row('abc123').envelope.labels,['INBOX','UNREAD','custom']);});
test('example records never enter the live Codex queue',t=>{const {store}=setup(t);loadExamples(store);assert.equal(store.rows().length,5);assert.equal(store.queue().length,0);});
test('confirmed notifications leave the pending queue; corrections return as new decisions',t=>{const {store}=setup(t);store.add(message());store.classified('abc123',{destination:'needs-you'},1);store.acknowledge({id:'abc123',revision:store.revision(store.row('abc123')),kind:'notified',receipt:'Confirmed user-visible report'});assert.equal(store.queue().length,0);store.correct('abc123','review');assert.equal(store.queue().length,1);});
test('new incoming reply resolves a tracked follow-up without sending email',t=>{const {store}=setup(t);store.add(message());store.waitFor('abc123','2026-10-22T07:30:00+02:00');assert.equal(store.waiting().length,1);store.add({...message('new-reply'),receivedAt:new Date(Date.now()+1000).toISOString()});assert.equal(store.waiting().length,0);assert.equal(store.row('new-reply').status,'pending');});
test('audit sample excludes examples and includes hidden-mail proposals',t=>{const {store}=setup(t);loadExamples(store);store.add(message());store.classified('abc123',{destination:'holding'},1);assert.equal(store.auditSample().length,1);assert.equal(store.auditSample()[0].id,'abc123');});
test('OAuth uses read-only scope and PKCE; invalid state does not exchange a token',async t=>{const {store}=setup(t);let calls=0;const p=new Providers(store,{get:()=>({}),save:()=>{}},{request:async()=>{calls++;}});const u=new URL(p.oauthStart({installed:{client_id:'123.apps.googleusercontent.com',client_secret:'test'}}));assert.equal(u.searchParams.get('scope'),'https://www.googleapis.com/auth/gmail.readonly');assert.equal(u.searchParams.get('code_challenge_method'),'S256');await assert.rejects(()=>p.oauthFinish(new URLSearchParams({state:'wrong',code:'stolen'})),/state/);assert.equal(calls,0);});
test('history checkpoint does not advance if a message cannot be fetched',async t=>{const {store}=setup(t);store.set('gmail_cursor',{phase:'history',historyId:'100'});const p=new Providers(store,{get:()=>({})});p.gmail=async path=>{if(path==='history')return {history:[{messagesAdded:[{message:{id:'new'}}]}],historyId:'200'};throw new Error('transient');};await assert.rejects(()=>p.sync());assert.equal(store.get('gmail_cursor').historyId,'100');});
test('initial pagination resumes rather than skipping older pages',async t=>{const {store}=setup(t);const p=new Providers(store,{get:()=>({})});let pages=0;p.gmail=async path=>path==='profile'?{historyId:'100'}:{messages:[],nextPageToken:'page'+(++pages)};await p.sync();assert.equal(store.get('gmail_cursor').phase,'initial');assert.equal(store.get('gmail_cursor').pageToken,'page3');});
test('expired Gmail history is explicit and schedules catch-up',async t=>{const {store}=setup(t);store.set('gmail_cursor',{phase:'history',historyId:'100'});const p=new Providers(store,{get:()=>({})});p.gmail=async()=>{const e=new Error('expired');e.status=404;throw e;};await assert.rejects(()=>p.sync());assert.equal(store.get('gmail_cursor'),null);assert.equal(store.stats().recentEvents[0].kind,'history_expired');});
test('a newly connected Google account cannot take over an existing connector queue',async t=>{
  const {store}=setup(t);store.set('gmail_account','owner@example.test');let saved=false;
  const p=new Providers(store,{get:()=>({}),save:()=>{saved=true;}},{request:async url=>url.includes('oauth2')?{refresh_token:'fakeRefresh',access_token:'fakeAccess',expires_in:3600}:{emailAddress:'other@example.test'}});
  const url=new URL(p.oauthStart({installed:{client_id:'123.apps.googleusercontent.com',client_secret:'test'}}));
  await assert.rejects(()=>p.oauthFinish(new URLSearchParams({state:url.searchParams.get('state'),code:'fake-code'})),/another Gmail account/);
  assert.equal(saved,false);assert.equal(store.get('gmail_account'),'owner@example.test');
});
test('Windows encrypts credentials without writing plaintext', {skip:process.platform!=='win32'},t=>{const {dir}=setup(t);const s=new SecretStore(dir);s.save({token:'test-private-token'});assert.deepEqual(new SecretStore(dir).get(),{token:'test-private-token'});});
test('HTTP refuses cross-origin access and unauthenticated API requests',async t=>{
  const {store}=setup(t);const providers={connectionStatus:()=>({gmail:false,cloudflare:false})};
  const app=createApp({store,providers,port:44319});await new Promise(resolve=>app.server.listen(44319,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  const base='http://127.0.0.1:44319';assert.equal((await fetch(base+'/')).status,200);
  assert.equal((await fetch(base+'/api/state')).status,403);
  assert.equal((await fetch(base+'/api/state',{headers:{'x-triage-key':app.key,Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(base+'/api/state',{headers:{'x-triage-key':app.key}})).status,200);
  assert.equal((await fetch(base+'/credentials.dpapi')).status,404);
  const invalid=await fetch(base+'/api/policy',{method:'POST',headers:{'x-triage-key':app.key,'Content-Type':'application/json'},body:'private-secret-invalid-json'});assert.equal(invalid.status,400);assert.ok(!(await invalid.text()).includes('private-secret'));
});
