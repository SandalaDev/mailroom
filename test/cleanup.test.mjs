import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { Providers, GMAIL_MODIFY, GMAIL_READONLY } from '../providers.mjs';
import { DEFAULT_POLICY, questions, validateAnswers, parseMessage } from '../core.mjs';
import { Cleanup, CLEANUP_DEFAULTS, recommendCleanup, cleanupQuery, validateCleanupSettings } from '../cleanup.mjs';
import { createApp } from '../server.mjs';

const policy={...DEFAULT_POLICY,mode:'organize'};
const old=()=>String(Date.now()-730*86400000);
function raw(id='old1',labels=['INBOX','UNREAD','custom']) {
  return {id,threadId:'thread-'+id,historyId:'1',internalDate:old(),sizeEstimate:2*1024*1024,labelIds:labels,
    payload:{mimeType:'text/plain',headers:[{name:'From',value:'Offers <offers@example.test>'},{name:'Subject',value:'Old seasonal promotion'}],body:{data:Buffer.from('A seasonal sale, now expired. No reply needed.').toString('base64url')}}};
}
function answers(overrides={}) {
  const choices={category:'promotion',destination:'holding',urgency:'can-wait',action:'no',deadline:'no',context:'yes',retention:'no',...overrides};
  return validateAnswers({answers:Object.fromEntries(Object.entries(questions()).map(([k,q])=>{
    const opts=Object.keys(q.criteria);return [k,{type:'choice',choice:choices[k],confidence:.99,probabilities:Object.fromEntries(opts.map(o=>[o,o===choices[k]?.995:.005/(opts.length-1)]))}];
  })),usage:{input_tokens:100}});
}
function setup(t,{messages=[raw()],clef=()=>answers(),pages,modify=true,mode='organize'}={}) {
  const dir=mkdtempSync(join(tmpdir(),'mailroom-cleanup-'));const store=new Store(dir);
  store.set('policy',{...policy,mode});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const mail=new Map(messages.map(m=>[m.id,m]));const calls=[],mutations=[];
  const providers={connectionStatus:()=>({gmail:true,cloudflare:true,gmailModify:modify}),
    gmail:async(path,params={})=>{
      calls.push({path,params});
      if(path==='messages')return pages?pages(params):{messages:[...mail.values()].filter(m=>!m.labelIds.includes('TRASH')).map(m=>({id:m.id}))};
      if(path.startsWith('messages/')){const m=mail.get(decodeURIComponent(path.slice(9)));if(!m)throw new Error('missing');return structuredClone(m);}
      if(path.startsWith('threads/'))return {id:path.slice(8),messages:[...mail.values()].filter(m=>m.threadId===decodeURIComponent(path.slice(8))).map(m=>structuredClone(m))};
      throw new Error('Unexpected request');
    },classify:async()=>clef(),cleanupAction:async(id,action)=>{
      mutations.push({id,action});const m=mail.get(id);m.historyId=String(Number(m.historyId)+1);
      if(action==='trash')m.labelIds=[...m.labelIds.filter(x=>x!=='INBOX'),'TRASH'];
      if(action==='restore')m.labelIds=m.labelIds.filter(x=>x!=='TRASH');
      if(action==='archive')m.labelIds=m.labelIds.filter(x=>!['INBOX','SPAM'].includes(x));
      return structuredClone(m);
    }};
  const cleanup=new Cleanup(store,providers);
  const scan=async()=>{cleanup.startScan({continuous:false});await cleanup.active;};
  const selection=(id='old1')=>[{id,revision:cleanup.row(id).revision}];
  return {dir,store,providers,cleanup,mail,calls,mutations,scan,selection};
}

test('cleanup filters reach years back, include Spam, exclude Trash/sent/drafts, and validate limits',()=>{
  const q=cleanupQuery({...CLEANUP_DEFAULTS,scope:'spam',minSizeMB:5});
  assert.match(q,/before:\d+/);assert.match(q,/in:spam/);assert.match(q,/-in:trash -in:sent -in:drafts/);assert.match(q,/larger:5242880/);
  for(const input of [{minAgeDays:-1},{minSizeMB:-1},{scheduleDays:NaN},{backlogThreshold:501},{scope:'trash'},{minAgeDays:'7'}])assert.throws(()=>validateCleanupSettings(input));
  assert.equal(validateCleanupSettings({minAgeDays:7}).minAgeDays,7);
});
test('cleanup treats high-certainty unwanted content as a candidate, never age alone',()=>{
  const m={...parseMessage(raw()),sizeBytes:10};
  const d={destination:'holding',category:'promotion',retention:'no'};
  assert.equal(recommendCleanup(m,d,policy,CLEANUP_DEFAULTS).recommendation,'delete');
  assert.equal(recommendCleanup(m,null,policy,CLEANUP_DEFAULTS).recommendation,'review');
  assert.equal(recommendCleanup({...m,receivedAt:new Date().toISOString()},d,policy,CLEANUP_DEFAULTS).recommendation,'keep');
});
test('important records, important senders, manual corrections, attachments, projects and conversations resist deletion',()=>{
  const m=parseMessage(raw()),d={destination:'holding',category:'promotion',retention:'no'};
  for(const [change,p,thread,local] of [
    [{protectedHint:true},policy,[],false],[{securityHint:true},policy,[],false],[{labels:['STARRED']},policy,[],false],
    [{}, {...policy,importantSenders:['offers@example.test']},[],false],[{},policy,[],true],
    [{hasAttachment:true},policy,[],false],[{incomplete:true},policy,[],false],
    [{}, {...policy,projects:['seasonal']},[],false],[{},policy,[m],false]
  ])assert.notEqual(recommendCleanup({...m,...change},d,p,CLEANUP_DEFAULTS,thread,Date.now(),local).recommendation,'delete');
  assert.equal(recommendCleanup(m,{...d,category:'financial'},policy,CLEANUP_DEFAULTS).recommendation,'keep');
});
test('historical scan stores recommendations separately, masks bodies in state, and makes no mutations',async t=>{
  const {cleanup,store,scan,calls,mutations}=setup(t,{messages:[raw('old1',['SPAM','UNREAD'])]});await scan();
  assert.equal(cleanup.row('old1').recommendation,'delete');assert.equal(store.rows().length,0);assert.equal(mutations.length,0);
  assert.equal(calls[0].params.includeSpamTrash,'true');assert.equal(calls[0].params.maxResults,'20');
  assert.equal(cleanup.state().potentialBytes,2*1024*1024);assert.equal(cleanup.state().items[0].envelope.body,undefined);
});
test('scans paginate, deduplicate prior recommendations and preserve resolved decisions',async t=>{
  const {cleanup,scan,calls,selection,mutations}=setup(t,{messages:[raw('old1'),raw('old2')],pages:p=>p.pageToken?{messages:[{id:'old2'}]}:{messages:[{id:'old1'}],nextPageToken:'page2'}});
  await scan();assert.equal(cleanup.state().hasMore,true);const firstRevision=cleanup.row('old1').revision;
  await scan();assert.equal(calls.find(c=>c.params.pageToken)?.params.pageToken,'page2');assert.equal(cleanup.state().pendingCount,2);
  const approval=cleanup.preview({action:'keep',items:selection()});await cleanup.apply({token:approval.token,confirmed:true});
  await scan();assert.equal(cleanup.row('old1').status,'kept');assert.equal(cleanup.row('old2').status,'pending');assert.notEqual(cleanup.row('old1').revision,firstRevision);assert.equal(mutations.length,0);
});
test('failed model output remains Review and does not advance the page; next scan retries',async t=>{
  let fail=true;const {cleanup,scan,store}=setup(t,{clef:()=>{if(fail)throw new Error('bad');return answers();},pages:()=>({messages:[{id:'old1'}],nextPageToken:'page2'})});
  await scan();assert.equal(cleanup.row('old1').recommendation,'review');assert.equal(store.get('cleanup_cursor').pageToken,'');
  fail=false;await scan();assert.equal(cleanup.row('old1').recommendation,'delete');assert.equal(store.get('cleanup_cursor').pageToken,'page2');
});
test('Observe and read-only connections cannot preview mailbox changes',async t=>{
  for(const options of [{mode:'observe'},{modify:false}]){
    const {cleanup,scan,selection,mutations}=setup(t,options);await scan();
    assert.throws(()=>cleanup.preview({action:'trash',items:selection()}),/Organize|permission/);
    assert.equal(mutations.length,0);
  }
});
test('confirmation is explicit, selection-bound, expires, and cannot be replayed',async t=>{
  const {cleanup,scan,selection,mutations}=setup(t);await scan();
  assert.throws(()=>cleanup.preview({action:'trash',items:[...selection(),...selection()]}),/distinct/);
  const approval=cleanup.preview({action:'trash',items:selection()});
  await assert.rejects(()=>cleanup.apply({token:approval.token,confirmed:false}),/confirmation/);assert.equal(mutations.length,0);
  cleanup.approvals.get(approval.token).expires=0;
  await assert.rejects(()=>cleanup.apply({token:approval.token,confirmed:true}),/expired/);
  const next=cleanup.preview({action:'trash',items:selection()});
  await cleanup.apply({token:next.token,confirmed:true});assert.equal(mutations.length,1);
  await assert.rejects(()=>cleanup.apply({token:next.token,confirmed:true}),/already used/);
});
test('confirmed trash records a receipt and can be restored with a separate confirmation',async t=>{
  const {cleanup,scan,selection,mutations,mail,store}=setup(t);store.add(parseMessage(mail.get('old1')));await scan();
  const approval=cleanup.preview({action:'trash',items:selection()});const result=await cleanup.apply({token:approval.token,confirmed:true});
  assert.equal(result.results[0].status,'trashed');assert.ok(store.row('old1').envelope.labels.includes('TRASH'));
  assert.equal(cleanup.state().history[0].action,'trash');
  const restore=cleanup.preview({action:'restore',items:selection()});await cleanup.apply({token:restore.token,confirmed:true});
  assert.equal(cleanup.row('old1').status,'restored');assert.ok(!mail.get('old1').labelIds.includes('TRASH'));
  assert.deepEqual(mutations.map(x=>x.action),['trash','restore']);assert.ok(mail.get('old1').labelIds.includes('UNREAD'));
});
test('changed message or new thread reply blocks a previously approved deletion',async t=>{
  for(const change of ['labels','reply']){
    const {cleanup,scan,selection,mutations,mail}=setup(t);await scan();const approval=cleanup.preview({action:'trash',items:selection()});
    if(change==='labels')mail.get('old1').labelIds.push('STARRED');
    else mail.set('reply',{...raw('reply'),threadId:'thread-old1'});
    const result=await cleanup.apply({token:approval.token,confirmed:true});
    assert.equal(result.results[0].ok,false);assert.match(result.results[0].error,/changed/);assert.equal(mutations.length,0);
  }
});
test('policy changes, settings changes and manual corrections invalidate action eligibility',async t=>{
  const {cleanup,scan,selection,store,mutations,mail}=setup(t);await scan();const approval=cleanup.preview({action:'trash',items:selection()});
  store.set('policy',{...policy,version:2});await assert.rejects(()=>cleanup.apply({token:approval.token,confirmed:true}),/Rules changed/);
  assert.throws(()=>cleanup.preview({action:'trash',items:selection()}),/changed/);
  await scan();cleanup.saveSettings({minAgeDays:365});assert.equal(cleanup.row('old1').policy_version,0);
  assert.throws(()=>cleanup.preview({action:'trash',items:selection()}),/changed/);
  await scan();store.add(parseMessage(mail.get('old1')));store.correct('old1','needs-you');
  assert.throws(()=>cleanup.preview({action:'trash',items:selection()}),/changed/);assert.equal(mutations.length,0);
});
test('partial action failures are reported individually and uncertain outcomes cannot be retried blindly',async t=>{
  const {cleanup,scan,providers,mutations}=setup(t,{messages:[raw('old1'),raw('old2')]});await scan();
  const original=providers.cleanupAction;providers.cleanupAction=async(id,action)=>{if(id==='old2')throw new Error('network');return original(id,action);};
  const approval=cleanup.preview({action:'trash',items:cleanup.rows().map(r=>({id:r.id,revision:r.revision}))});
  const result=await cleanup.apply({token:approval.token,confirmed:true});assert.equal(result.results.filter(r=>r.ok).length,1);
  assert.equal(cleanup.row('old2').status,'uncertain');assert.throws(()=>cleanup.preview({action:'trash',items:[{id:'old2',revision:cleanup.row('old2').revision}]}),/no longer available/);
  assert.equal(mutations.length,1);
});
test('scheduled review is opt-in, respects threshold and interval, and only scans',async t=>{
  const {cleanup,mutations,calls,store}=setup(t);
  await cleanup.tick();assert.equal(calls.length,0);
  cleanup.saveSettings({scheduleDays:7,backlogThreshold:2});await cleanup.tick();assert.equal(cleanup.rows().length,0);
  cleanup.saveSettings({backlogThreshold:1});await cleanup.tick();await cleanup.active;
  assert.equal(cleanup.row('old1').recommendation,'delete');assert.equal(mutations.length,0);
  const count=calls.length;await cleanup.tick();assert.equal(calls.length,count);assert.ok(store.get('cleanup_schedule_check'));
});
test('restart converts an interrupted mutation to uncertain instead of retrying',async t=>{
  const {cleanup,scan,store,providers}=setup(t);await scan();store.db.prepare("UPDATE cleanup_items SET status='acting'").run();
  const restarted=new Cleanup(store,providers);assert.equal(restarted.row('old1').status,'uncertain');
});
test('optional OAuth scope is explicit and granted scope, not the checkbox, controls write access',async t=>{
  const {store}=setup(t);let saved={};
  const p=new Providers(store,{get:()=>saved,save:value=>{saved=value;}},{request:async url=>url.includes('oauth2')?{access_token:'testAccess',refresh_token:'testRefresh',expires_in:3600,scope:GMAIL_READONLY}:{emailAddress:'owner@example.test'}});
  const credentials={installed:{client_id:'123.apps.googleusercontent.com',client_secret:'test'}};
  assert.equal(new URL(p.oauthStart(credentials)).searchParams.get('scope'),GMAIL_READONLY);
  const url=new URL(p.oauthStart(credentials,{cleanup:true}));assert.equal(url.searchParams.get('scope'),GMAIL_MODIFY);
  await p.oauthFinish(new URLSearchParams({state:url.searchParams.get('state'),code:'test-code'}));assert.equal(p.connectionStatus().gmailModify,false);
});
test('provider allows only message-level archive/trash/restore and preserves unread/custom labels',async t=>{
  const {store}=setup(t);const requests=[];
  const p=new Providers(store,{get:()=>({google:{refresh_token:'testRefresh',access_token:'testAccess',expires_at:Date.now()+3600000,scope:GMAIL_MODIFY}})},{request:async(url,init)=>{requests.push({url,init});return {id:'old1',labelIds:['UNREAD','custom']};}});
  await p.cleanupAction('old1','archive');
  assert.deepEqual(JSON.parse(requests[0].init.body),{removeLabelIds:['INBOX','SPAM']});assert.match(requests[0].url,/messages\/old1\/modify$/);
  await assert.rejects(()=>p.cleanupAction('old1','permanent-delete'),/Unsupported/);
  await assert.rejects(()=>p.cleanupAction('old1','trash'),/confirm Trash/);
  assert.equal(requests.length,2);
});
test('cleanup HTTP endpoints require session authorization and implement scan-preview-confirm',async t=>{
  const {store,providers}=setup(t);const port=44321,app=createApp({store,providers,port});
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  const base=`http://127.0.0.1:${port}`,headers={'x-triage-key':app.key,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/cleanup/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/cleanup/scan',{method:'POST',headers,body:'{}'})).status,200);await app.cleanup.active;
  const state=await (await fetch(base+'/api/state',{headers})).json();assert.equal(state.cleanup.items.length,1);assert.equal(state.cleanup.items[0].envelope.body,undefined);
  const item=state.cleanup.items[0];const preview=await (await fetch(base+'/api/cleanup/preview',{method:'POST',headers,body:JSON.stringify({action:'keep',items:[{id:item.id,revision:item.revision}]})})).json();
  const apply=await fetch(base+'/api/cleanup/apply',{method:'POST',headers,body:JSON.stringify({token:preview.token,confirmed:true})});assert.equal(apply.status,200);assert.equal(app.cleanup.row(item.id).status,'kept');
});


test('human review can override a protected recommendation without mutating Gmail',async t=>{
  const protectedMessage=raw();protectedMessage.payload.headers[1].value='Invoice for last year';
  const {cleanup,scan,selection,mutations}=setup(t,{messages:[protectedMessage]});await scan();
  assert.equal(cleanup.row('old1').recommendation,'keep');
  const item=selection()[0];
  await assert.rejects(()=>cleanup.review({...item,recommendation:'delete',reviewed:false}),/confirm your review/);
  await cleanup.review({...item,recommendation:'delete',reviewed:true});
  assert.equal(cleanup.row('old1').manual,1);assert.equal(cleanup.row('old1').recommendation,'delete');assert.equal(mutations.length,0);
  const approval=cleanup.preview({action:'trash',items:selection()});
  await cleanup.apply({token:approval.token,confirmed:true});assert.equal(mutations.length,1);
});

test('a local correction made after human review invalidates its provider snapshot',async t=>{
  const {cleanup,scan,selection,mutations,store,mail}=setup(t);store.add(parseMessage(mail.get('old1')));await scan();
  await cleanup.review({...selection()[0],recommendation:'delete',reviewed:true});
  const approval=cleanup.preview({action:'trash',items:selection()});
  store.correct('old1','needs-you');
  const result=await cleanup.apply({token:approval.token,confirmed:true});
  assert.equal(result.results[0].ok,false);assert.equal(mutations.length,0);
});

test('permission or policy changes during a provider recheck block mutation',async t=>{
  const {cleanup,scan,selection,mutations,providers,store}=setup(t);await scan();
  const approval=cleanup.preview({action:'trash',items:selection()}),original=providers.gmail;
  providers.gmail=async(...args)=>{const result=await original(...args);store.set('policy',{...policy,mode:'observe',version:2});return result;};
  const result=await cleanup.apply({token:approval.token,confirmed:true});
  assert.equal(result.results[0].ok,false);assert.equal(mutations.length,0);
});


test('manual review rejects unseen changes to the message or conversation',async t=>{
  const {cleanup,scan,selection,mail,mutations}=setup(t);await scan();
  const item=selection()[0];mail.get('old1').historyId='2';
  await assert.rejects(()=>cleanup.review({...item,recommendation:'delete',reviewed:true}),/changed/);
  assert.equal(cleanup.row('old1').manual,0);assert.equal(mutations.length,0);
});

test('confirmed cleanup removes messages from the operator queue and restore makes them visible again',async t=>{
  const {cleanup,scan,selection,store,mail}=setup(t);store.add(parseMessage(mail.get('old1')));store.classified('old1',{destination:'archive'},1);await scan();
  assert.equal(store.queue().length,1);
  const trash=cleanup.preview({action:'trash',items:selection()});await cleanup.apply({token:trash.token,confirmed:true});
  assert.equal(store.queue().length,0);assert.equal(store.auditSample().length,0);
  const restore=cleanup.preview({action:'restore',items:selection()});await cleanup.apply({token:restore.token,confirmed:true});assert.equal(store.queue().length,1);
});
