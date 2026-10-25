import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../store.mjs';
import {Cleanup,cleanupQuery,CLEANUP_DEFAULTS} from '../cleanup.mjs';
import {Usage,UsageLimitError} from '../usage.mjs';
import {Providers} from '../providers.mjs';
import {questions,validateAnswers,parseMessage} from '../core.mjs';
import {subscriptionCandidate,subscriptionsState,subscriptionReceipt} from '../subscriptions.mjs';
import {createApp} from '../server.mjs';

function setup(t){const dir=mkdtempSync(join(tmpdir(),'mailroom-scan-'));const store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,dir};}
function raw(id){return {id,threadId:'t-'+id,internalDate:String(Date.now()-800*86400000),labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'offers@example.test'},{name:'Subject',value:'Expired seasonal offer'}],body:{data:Buffer.from('A promotion with no request.').toString('base64url')}}};}
function answer(){const selected={category:'promotion',destination:'holding',urgency:'can-wait',action:'no',deadline:'no',context:'yes',retention:'no'};return {answers:Object.fromEntries(Object.entries(questions()).map(([k,q])=>{const opts=Object.keys(q.criteria);return [k,{type:'choice',choice:selected[k],confidence:.99,probabilities:Object.fromEntries(opts.map(x=>[x,x===selected[k]?.995:.005/(opts.length-1)]))}];})),usage:{input_tokens:100}};}
function fakeProvider(total=30){const mail=new Map(Array.from({length:total},(_,i)=>{const id='m'+i;return [id,raw(id)];}));let modelCalls=0;const pages=[];
 return {mail,pages,get calls(){return modelCalls;},connectionStatus:()=>({gmail:true,cloudflare:true}),gmail:async(path,params)=>{if(path==='messages'){const page=Number(params.pageToken||0);pages.push(page);return {messages:[...mail.keys()].slice(page*10,page*10+10).map(id=>({id})),nextPageToken:(page+1)*10<total?String(page+1):undefined,resultSizeEstimate:total};}if(path.startsWith('messages/'))return structuredClone(mail.get(path.slice(9)));return {messages:[...mail.values()].filter(m=>m.threadId===path.slice(8))};},classify:async()=>{modelCalls++;return validateAnswers(answer());}};
}
test('a continuous scan traverses multiple pages in one run and groups review by sender',async t=>{const {store}=setup(t),p=fakeProvider(),c=new Cleanup(store,p);c.startScan();await c.active;assert.equal(c.state().job.status,'completed');assert.equal(c.state().job.processed,30);assert.equal(p.calls,30);assert.deepEqual(p.pages,[0,1,2]);assert.equal(c.groups()[0].count,30);assert.equal(c.list({sender:'offers@example.test',offset:10,limit:5}).items.length,5);});
test('pause checkpoints a partial page and restart/resume does not repeat completed model calls',async t=>{
 const {store}=setup(t),p=fakeProvider(10),c=new Cleanup(store,p);let entered,release;const waiting=new Promise(r=>entered=r),gate=new Promise(r=>release=r),original=p.classify;
 p.classify=async(...args)=>{entered();await gate;return original(...args);};c.startScan();await waiting;c.pause();release();await c.active;
 assert.equal(c.state().job.status,'paused');assert.equal(c.state().job.processed,1);assert.equal(store.get('cleanup_cursor').pendingIds.length,9);
 const restarted=new Cleanup(store,p);restarted.startScan({resume:true});await restarted.active;assert.equal(restarted.state().job.status,'completed');assert.equal(p.calls,10);
});
test('the review count limit preserves remaining messages for a subsequent run',async t=>{const {store}=setup(t),p=fakeProvider(25),c=new Cleanup(store,p);c.saveSettings({scanLimit:20});c.startScan();await c.active;assert.equal(c.state().job.status,'limited');assert.equal(p.calls,20);c.startScan({resume:true});await c.active;assert.equal(c.state().job.status,'completed');assert.equal(p.calls,25);});
test('a model budget limit leaves the unprocessed ID at the checkpoint',async t=>{const {store}=setup(t),p=fakeProvider(1),c=new Cleanup(store,p);p.classify=async()=>{throw new UsageLimitError('Daily budget reached');};c.startScan();await c.active;assert.equal(c.state().job.status,'limited');assert.deepEqual(store.get('cleanup_cursor').pendingIds,['m0']);assert.equal(c.rows().length,0);});
test('three provider failures pause a continuous run rather than burning through the mailbox',async t=>{const {store}=setup(t),p=fakeProvider(10),c=new Cleanup(store,p);p.classify=async()=>{throw new Error('outage');};c.startScan();await c.active;assert.equal(c.state().job.status,'paused');assert.equal(c.rows().length,3);assert.equal(store.get('cleanup_cursor').pendingIds.length,7);});
test('zero minimum age removes the date constraint and never imposes a maximum age',()=>{assert.ok(!cleanupQuery({...CLEANUP_DEFAULTS,minAgeDays:0}).includes('before:'));assert.ok(cleanupQuery(CLEANUP_DEFAULTS).includes('before:'));});
test('usage counts successful calls, reports model-specific neurons and preserves unknown-call reservations',t=>{
 const {store}=setup(t),u=new Usage(store),account='test-account';const id=u.begin({account,model:'clef',purpose:'cleanup',payload:{text:'fictional'}});u.finish(id,answer());
 const unknown=u.begin({account,model:'clef-flash',purpose:'triage',payload:{text:'fictional'}});u.finish(unknown,null,new Error('timeout'));
 const state=u.state(account);assert.equal(state.today.calls,2);assert.equal(state.today.tokens,100);assert.equal(state.today.neurons,2.1818);assert.equal(state.today.unknown,1);assert.ok(state.today.reserved>0);assert.equal(state.accountRemainingNeurons,null);assert.equal(state.settings.monthlyFeeUSD,5);assert.equal(state.includedNeurons,10000);
});
test('daily and per-run budgets reject calls before any provider request',t=>{
 const {store}=setup(t),u=new Usage(store);u.saveSettings({dailyNeuronBudget:100});assert.throws(()=>u.begin({account:'a',model:'clef',purpose:'cleanup',payload:{text:'x'.repeat(10000)}}),UsageLimitError);
 assert.throws(()=>u.begin({account:'a',model:'clef',purpose:'cleanup',runId:'r',runBudget:1,payload:{text:'x'.repeat(1000)}}),UsageLimitError);assert.equal(u.total().calls,0);
});
test('daily usage resets at UTC midnight while overage is calculated separately for each day',t=>{
 const {store}=setup(t),u=new Usage(store);u.saveSettings({dailyNeuronBudget:1000000});const id=u.begin({account:'a',model:'clef',purpose:'cleanup',payload:{text:'x'}});u.finish(id,{usage:{input_tokens:1000000}});
 const date=new Date();date.setUTCDate(date.getUTCDate()-1);store.db.prepare('UPDATE model_usage SET at=? WHERE id=?').run(date.toISOString(),id);
 const s=u.state('a');assert.equal(s.today.calls,0);assert.equal(s.all.tokens,1000000);if(date.toISOString().slice(0,7)===s.dayUTC.slice(0,7))assert.ok(s.estimatedMonthlyAppOverageUSD>0);assert.ok(s.nextResetUTC.endsWith('T00:00:00.000Z'));
});
test('provider ledger includes connection tests and counts billable input even when answer validation fails',async t=>{
 const {store}=setup(t);const accountId='0'.repeat(32),cf={accountId,model:'clef',token:'fictional-token'};const p=new Providers(store,{get:()=>({cloudflare:cf})},{request:async()=>({usage:{input_tokens:123},answers:{}})});
 await assert.rejects(()=>p.classify(parseMessage(raw('m')),[],store.get('policy'),undefined,{purpose:'connection-test'}));
 const usage=p.usageState();assert.equal(usage.today.calls,1);assert.equal(usage.today.tokens,123);assert.equal(store.db.prepare('SELECT purpose,status FROM model_usage').get().status,'failed');
});
test('subscription detection accepts explicit dates, leaves ambiguous dates for review and deduplicates ingestion',t=>{
 const {store}=setup(t),message={...parseMessage(raw('trial')),receivedAt:new Date().toISOString(),subject:'Your trial ends',body:'Your trial expires on 2026-12-02.'};
 assert.equal(subscriptionCandidate(message).deadlineDate,'2026-12-02');assert.equal(subscriptionCandidate({...message,body:'Your trial expires December 2, 2026.'}).deadlineDate,'2026-12-02');
 assert.equal(subscriptionCandidate({...message,body:'Your trial started 2026-11-01 and ends 2026-12-02.'}).deadlineDate,null);
 assert.equal(subscriptionCandidate({...message,subject:'Offers',body:'Start a free trial today!'}),null);
 store.add(message);store.add(message);assert.equal(subscriptionsState(store).items.length,1);assert.deepEqual(subscriptionsState(store).preferences.daysBefore,[3,1]);
 assert.throws(()=>subscriptionReceipt(store,{messageId:message.id,status:'calendar_added'}),/confirmed Calendar/);
 subscriptionReceipt(store,{messageId:message.id,status:'calendar_added',eventId:'provider-confirmed-event',calendarId:'primary'});assert.equal(subscriptionsState(store).items.length,0);
});
test('operator report exposes usage, sender groups and subscription candidates without model calls',async t=>{
 const {store}=setup(t),p=fakeProvider(0),app=createApp({store,providers:p,port:44322});await new Promise(r=>app.server.listen(44322,'127.0.0.1',r));t.after(()=>new Promise(r=>app.server.close(r)));
 const response=await fetch('http://127.0.0.1:44322/api/operator/report',{headers:{'x-triage-key':app.key}});const report=await response.json();assert.equal(response.status,200);assert.ok(report.usage);store.add(parseMessage(raw('operator-message')));const messageResponse=await fetch('http://127.0.0.1:44322/api/operator/message?id=operator-message',{headers:{'x-triage-key':app.key}});assert.equal(messageResponse.status,200);assert.ok((await messageResponse.json()).envelope.body);assert.deepEqual(report.subscriptions.preferences.daysBefore,[3,1]);assert.equal(p.calls,0);
});

test('untracked legacy usage is disclosed rather than presented as a complete zero',t=>{const {store}=setup(t);store.db.prepare('INSERT INTO runs(started_at,input_tokens) VALUES (?,?)').run('2026-01-01T00:00:00Z',500);const u=new Usage(store),state=u.state('a');assert.equal(state.legacyTriageTokens,500);assert.equal(state.historyIncomplete,true);assert.equal(state.accountRemainingNeurons,null);});
