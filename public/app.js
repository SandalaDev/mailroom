const $=id=>document.getElementById(id);
const key=document.querySelector('meta[name="triage-key"]').content;
let state=null,view='inbox',filter='all',selected=null;
const names={'needs-you':'Needs you',review:'Review',digest:'Digest',archive:'Archive',holding:'Holding'};
function el(tag,className,text){const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;}
function showNotice(text,error=false){UI.toast(text,error);}
async function api(path,data){const r=await fetch('/api/'+path,{method:data===undefined?'GET':'POST',headers:{'x-triage-key':key,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});const result=await r.json();if(!r.ok)throw new Error(result.error||'Request failed.');return result;}
async function task(button,fn){const old=button.innerHTML,status=UI.pending(button);button.disabled=true;try{await fn();status.ok();}catch(e){status.fail();showNotice(e.message,true);}finally{button.disabled=false;button.innerHTML=old;if(state?.cleanup)renderCleanup();}}
function switchView(next){UI.viewTransition(next,()=>{view=next;document.querySelectorAll('.view').forEach(v=>v.hidden=v.id!=='view-'+view);document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view===view));$('page-name').textContent={inbox:'Queue',digest:'Digest',holding:'Holding',waiting:'Waiting',activity:'Activity',cleanup:'Cleanup',subscriptions:'Subscriptions',policy:'Rules',setup:'Connections'}[view];});}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(n=>n.classList.toggle('selected',n===b));renderMessages();}));
function date(value){return value?new Date(value).toLocaleString('en-GB',{timeZone:'UTC',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'Not yet';}
function empty(container,title,text,example=false){const box=el('div','empty');const mark=el('span','empty-icon');mark.append(UI.icon(container.id==='activity-list'?'i-activity':'i-inbox'));box.append(mark,el('h3','',title),el('p','',text));if(example){const b=el('button','button','Load examples');b.onclick=()=>task(b,loadExamples);box.append(b);}container.append(box);}
function rowCard(row){const b=el('button','message-row');b.type='button';const m=row.envelope,d=row.decision,dest=d?.destination||'pending';b.dataset.key=row.id;b.dataset.sig=dest;const status=UI.icon('st-'+dest,'st st-'+dest);const main=el('div','message-main');const text=el('div','message-text');text.append(el('div','message-subject',m.subject),el('div','message-preview',m.snippet));main.append(el('div','message-sender',m.sender+(row.source==='demo'?' · example':'')),text);const end=el('div','message-end');end.append(el('span','badge '+(d?.destination||'review'),d?names[d.destination]:'Awaiting Clef'),el('div','message-time',date(m.receivedAt)),UI.icon('i-chevron','i row-chev'));b.append(status,main,end);b.addEventListener('click',()=>openMessage(row.id));return b;}
function renderMessages(){if(!state)return;const messages=state.messages;const list=$('message-list');const commit=UI.list(list);list.replaceChildren();for(const n of document.querySelectorAll('[data-count]')){const k=n.dataset.count;n.textContent=messages.filter(r=>k==='all'||r.decision?.destination===k).length||'';}const visible=messages.filter(r=>filter==='all'||r.decision?.destination===filter);if(!visible.length)empty(list,messages.length?'No messages match this filter.':'No messages.',messages.length?'':'Connect Gmail and Clef, or load example data.',!messages.length);else visible.forEach(r=>list.append(rowCard(r)));commit();UI.syncSegmented();$('demo-banner').hidden=!messages.some(r=>r.source==='demo');for(const [dest,id] of [['digest','digest-list'],['holding','holding-list']]){const target=$(id);const done=UI.list(target);target.replaceChildren();const rows=messages.filter(r=>r.decision?.destination===dest);if(!rows.length)empty(target,dest==='digest'?'No digest messages.':'No messages in Holding.','');else rows.forEach(r=>target.append(rowCard(r)));done();}}
function render(){const s=state,live=s.messages.filter(r=>r.source==='gmail');const count=dest=>live.filter(r=>dest.includes(r.decision?.destination)).length;const setup=!(s.connections.gmail&&s.connections.cloudflare);UI.count($('stat-attention'),count(['needs-you','review']));UI.count($('stat-digest'),count(['digest']));UI.count($('stat-sorted'),count(['archive','holding']));UI.count($('queue-count'),live.length);$('mode-tag').textContent=s.policy.mode==='observe'?'Observe mode':'Organize mode';$('mode-tag').classList.toggle('organize',s.policy.mode!=='observe');$('step-gmail').classList.toggle('done',!!s.connections.gmail);$('step-clef').classList.toggle('done',!!s.connections.cloudflare);$('gmail-status').classList.toggle('on',!!s.connections.gmail);$('clef-status').classList.toggle('on',!!s.connections.cloudflare);$('conn-dot').classList.toggle('on',!setup);UI.busy(s.busy||s.cleanup?.busy);$('sorted-note').textContent=s.policy.mode==='observe'?'· proposals only':'· see Activity';$('setup-banner').hidden=!setup;$('setup-dot').hidden=!setup;$('run').disabled=setup||s.busy;$('gmail-status').textContent=s.connections.gmail?(s.connections.gmailModify?'Connected · cleanup enabled':'Connected · read only'):'Not connected';$('clef-status').textContent=s.connections.cloudflare?'Connected · '+s.connections.model:'Not connected';$('connection-summary').textContent=s.connections.email||'Not connected';$('last-check').textContent=s.lastRun?`Last check ${date(s.lastRun.finished_at||s.lastRun.started_at)} · ${s.lastRun.processed} classified`:'No checks yet';if(!document.querySelector('#policy-form :focus')){$('important').value=s.policy.importantSenders.join('\n');$('unwanted').value=s.policy.unwantedSenders.join('\n');$('projects').value=s.policy.projects.join('\n');$('policy-note').value=s.policy.note;$('policy-mode').value=s.policy.mode;}$('policy-version').textContent='Policy version '+s.policy.version;$('cf-model').value=s.connections.model;renderMessages();const log=$('activity-list');const logDone=UI.list(log);log.replaceChildren();if(!s.recentEvents.length)log.append(el('p','','No activity yet.'));for(const event of s.recentEvents){const line=el('div','event');line.dataset.key=event.at+event.kind+(event.message_id||'');line.append(el('span','',event.kind.replaceAll('_',' ')+(event.message_id?' · '+event.message_id:'')),el('time','',date(event.at)));log.append(line);}logDone();const health=$('health');health.replaceChildren();const stale=s.lastRun&&Date.now()-Date.parse(s.lastRun.finished_at||s.lastRun.started_at)>15*60000;health.classList.toggle('warn',setup||s.lastRun?.ok===0||!!stale);health.append(el('strong','',setup?'Setup required':s.lastRun?.ok===0?'A check needs attention':stale?'Background checks may have stopped':s.lastRun?'Background checks are current':'Ready for the first check'),el('p','',s.lastRun?.error||`${s.backlog.count} messages awaiting classification. Monitoring runs only while this app is running.`));if(s.lastRun?.ok===0)showNotice(s.lastRun.error||'The last run did not finish successfully.',true);}
async function refresh(){state=await api('state');render();}
async function loadExamples(){await api('examples',{});await refresh();switchView('inbox');showNotice('Examples loaded. No email read, no model called.');}
async function openMessage(id){try{const row=await api('message?id='+encodeURIComponent(id));selected=id;$('detail-subject').textContent=row.envelope.subject;$('detail-sender').textContent=row.envelope.sender+' · '+date(row.envelope.receivedAt);$('detail-tags').replaceChildren(el('span','badge '+(row.decision?.destination||'review'),row.decision?names[row.decision.destination]:'Pending'),el('span','badge',row.source==='demo'?'Example decision':row.decision?.origin||'Pending'));$('detail-reasons').textContent=(row.decision?.reasons||[]).map(x=>x.replaceAll('_',' ')).join(' · ')||'No exception flags.';$('detail-body').textContent=row.envelope.body;$('correction-destination').value=row.decision?.destination||'review';$('message-dialog').showModal();}catch(e){showNotice(e.message,true);}}
$('close-dialog').onclick=()=>$('message-dialog').close();
$('correction-form').onsubmit=e=>{e.preventDefault();task(e.submitter,async()=>{await api('correct',{id:selected,destination:$('correction-destination').value});$('message-dialog').close();await refresh();showNotice('Correction saved locally. Gmail unchanged.');});};
$('refresh').onclick=e=>task(e.currentTarget,refresh);
$('examples').onclick=e=>task(e.currentTarget,loadExamples);
$('run').onclick=e=>task(e.currentTarget,async()=>{const result=await api('run',{});await refresh();showNotice(result.setupRequired?'Connect both accounts first.':result.busy?'A check is already in progress.':`${result.processed} messages classified. ${result.failed} awaiting retry. Gmail is unchanged.`);});
$('cloudflare-form').onsubmit=e=>{e.preventDefault();task(e.submitter,async()=>{await api('cloudflare',{accountId:$('cf-account').value.trim(),token:$('cf-token').value.trim(),model:$('cf-model').value});$('cf-token').value='';await refresh();showNotice('Clef passed a synthetic connection test. No real email was used.');});};
$('google-form').onsubmit=e=>{e.preventDefault();task(e.submitter,async()=>{const file=$('google-file').files[0];if(!file||file.size>50000)throw new Error('Choose a Google Desktop client JSON file smaller than 50 KB.');const credentials=JSON.parse(await file.text());const result=await api('google',{...credentials,cleanup:$('google-cleanup').checked});$('google-file').value='';window.location.assign(result.url);});};
$('policy-form').onsubmit=e=>{e.preventDefault();task(e.submitter,async()=>{const lines=id=>$(id).value.split('\n').map(x=>x.trim()).filter(Boolean);await api('policy',{importantSenders:lines('important'),unwantedSenders:lines('unwanted'),projects:lines('projects'),note:$('policy-note').value,mode:$('policy-mode').value});await refresh();showNotice('Saved as a new policy version.');});};
const followup=$('followup-template').content.cloneNode(true);$('message-dialog').append(followup);
$('waiting-form').onsubmit=e=>{e.preventDefault();task(e.submitter,async()=>{await api('waiting',{id:selected,dueAt:$('waiting-date').value+'T07:30:00Z'});$('message-dialog').close();await refresh();renderWaiting();showNotice('Follow-up tracked. An incoming reply closes it.');});};
function renderWaiting(){const list=$('waiting-list');list.replaceChildren();for(const w of state?.waiting||[]){const row=el('div','event');row.append(el('span','',w.subject+(w.source==='demo'?' · example':'')),el('span','badge '+(w.overdue?'review':''),(w.overdue?'Overdue · ':'Due ')+date(w.due_at)));list.append(row);}if(!list.children.length)list.append(el('p','','No follow-ups tracked.'));}
const originalRefresh=refresh;
let cleanupFilter='all',cleanupSelection=new Map(),cleanupApproval=null,cleanupSettingsRendered=null,cleanupDetailRow=null,cleanupSender='',cleanupOffset=0,cleanupGroupsSignature='';
const cleanupNames={delete:'Delete candidate',archive:'Archive',review:'Review',keep:'Keep'};
function bytes(value){if(!value)return '0 B';const units=['B','KB','MB','GB'];const i=Math.min(3,Math.floor(Math.log(value)/Math.log(1024)));return (value/1024**i).toFixed(i?1:0)+' '+units[i];}
function cleanupDate(value){return new Date(value).toLocaleString('en-GB',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})+' UTC';}
function renderCleanup(){
  const c=state.cleanup;if(!c)return;
  UI.count($('cleanup-count'),c.pendingCount);document.body.classList.toggle('cleanup-busy',!!c.busy);UI.busy(state.busy||c.busy);
  $('cleanup-summary').textContent=`${c.pendingCount} pending · ${bytes(c.potentialBytes)} in Delete candidates, reclaimable only after permanent deletion.`;
  $('cleanup-scan').disabled=c.busy||!state.connections.gmail||!state.connections.cloudflare;
  $('cleanup-restart').disabled=$('cleanup-scan').disabled;
  const job=c.job,canResume=job&&['paused','limited','failed'].includes(job.status);
  $('cleanup-pause').hidden=!c.busy||!job||!['running','pausing'].includes(job.status);$('cleanup-pause').disabled=job?.status==='pausing';
  $('cleanup-select-visible').disabled=c.busy;
  $('cleanup-prev').disabled=cleanupOffset===0;$('cleanup-next').disabled=cleanupOffset+c.items.length>=(c.listTotal||0);
  $('cleanup-page-info').textContent=c.listTotal?`${cleanupOffset+1}–${cleanupOffset+c.items.length} of ${c.listTotal}`:'No matching messages';
  $('cleanup-scan').textContent=c.busy?'Working…':canResume?'Resume scan':'Start scan';
  $('cleanup-permission').hidden=!!state.connections.gmailModify&&state.policy.mode==='organize';
  const scan=c.scan;
  $('cleanup-progress').textContent=c.busy?`Working in the background. ${scan?.processed||0} reviewed in this batch. You can use other pages.`:scan?`${scan.finishedAt?'Last scan '+date(scan.finishedAt):'Previous scan was interrupted; scan again to resume.'} · ${scan.processed} reviewed · ${scan.failed} failed.${scan.error?' '+scan.error:''}${c.hasMore?' More older mail is available.':''}`:'No cleanup scans yet. Save your options, then scan older mail.';
  if(job)$('cleanup-progress').textContent=`${job.status} · ${job.visited} examined · ${job.processed} reviewed · ${job.skipped} already handled · ${job.failed} errors${job.modelUsage?' · '+job.modelUsage.calls+' model calls':''}. ${job.reason||''}`;
  const groupSignature=JSON.stringify((c.groups||[]).map(g=>[g.sender,g.count]));
  if(groupSignature!==cleanupGroupsSignature){const select=$('cleanup-sender');select.replaceChildren(el('option','','All senders'));select.firstChild.value='';for(const group of c.groups||[]){const option=el('option','',group.sender+' ('+group.count+')');option.value=group.sender;select.append(option);}select.value=cleanupSender;cleanupGroupsSignature=groupSignature;}
  const signature=JSON.stringify(c.settings);
  if(cleanupSettingsRendered!==signature){
    for(const [id,key] of [['cleanup-run-limit','scanLimit'],['cleanup-run-budget','scanNeuronBudget'],['cleanup-age','minAgeDays'],['cleanup-size','minSizeMB'],['cleanup-scope','scope'],['cleanup-schedule','scheduleDays'],['cleanup-threshold','backlogThreshold']])$(id).value=c.settings[key];
    cleanupSettingsRendered=signature;
  }
  const byId=new Map(c.items.map(r=>[r.id,r]));
  for(const [id,revision] of cleanupSelection){const row=byId.get(id);if(!row||row.revision!==revision||!['pending','trashed'].includes(row.status))cleanupSelection.delete(id);}
  const list=$('cleanup-list');const commit=UI.list(list);list.replaceChildren();
  const rows=c.items.filter(r=>cleanupFilter==='history'?r.status!=='pending':r.status==='pending'&&(cleanupFilter==='all'||r.recommendation===cleanupFilter));
  if(!rows.length)empty(list,'Nothing here yet.',cleanupFilter==='history'?'Completed actions will appear here.':'Scan older mail or choose another filter.');
  for(const row of rows){
    const card=el('article','cleanup-card');card.dataset.key=row.id;card.dataset.sig=row.status+row.recommendation;
    const label=el('label','cleanup-select');const check=document.createElement('input');check.type='checkbox';check.checked=cleanupSelection.has(row.id);check.disabled=c.busy||!['pending','trashed'].includes(row.status)||!!(row.status==='trashed'&&row.error);check.setAttribute('aria-label','Select '+row.envelope.subject);
    check.onchange=()=>{if(check.checked)cleanupSelection.set(row.id,row.revision);else cleanupSelection.delete(row.id);updateCleanupActions();};label.append(check);
    const content=el('div','cleanup-content');const open=el('button','cleanup-subject',row.envelope.subject);open.onclick=()=>openCleanup(row.id);
    const meta=el('p','cleanup-meta',`${row.envelope.sender} · ${cleanupDate(row.envelope.receivedAt)} · ${bytes(row.envelope.sizeBytes)}${row.envelope.labels.includes('SPAM')?' · Spam':''}`);
    content.append(open,meta,el('p','cleanup-reasons',row.reasons.join(' ')));
    if(row.stale)content.append(el('p','cleanup-error','Rules or scan options changed. Scan again before acting.'));
    if(row.error)content.append(el('p','cleanup-error',row.error));
    const badge=el('span','badge '+(row.status==='pending'?row.recommendation:'holding'),row.status==='pending'?cleanupNames[row.recommendation]:row.status);
    card.append(label,content,badge);list.append(card);
  }
  commit();
  updateCleanupActions();
}
function updateCleanupActions(){
  const c=state.cleanup,rows=c.items.filter(r=>cleanupSelection.has(r.id)),n=rows.length;
  const enabled=!c.busy&&state.connections.gmailModify&&state.policy.mode==='organize';
  $('cleanup-selection').closest('.cleanup-actions').classList.toggle('has-selection',n>0);$('cleanup-selection').textContent=n?`${n} selected · ${bytes(rows.reduce((sum,r)=>sum+r.envelope.sizeBytes,0))}`:'Select messages to review an action.';
  $('cleanup-keep').disabled=c.busy||!n||rows.some(r=>r.status!=='pending');
  $('cleanup-archive').disabled=!enabled||!n||rows.some(r=>r.stale||r.status!=='pending'||r.recommendation!=='archive');
  $('cleanup-trash').disabled=!enabled||!n||rows.some(r=>r.stale||r.status!=='pending'||r.recommendation!=='delete');
  $('cleanup-restore').hidden=cleanupFilter!=='history';
  $('cleanup-restore').disabled=!enabled||!n||rows.some(r=>r.status!=='trashed'||r.error);
}
async function openCleanup(id){try{
  const row=await api('cleanup/message?id='+encodeURIComponent(id));cleanupDetailRow=row;
  $('cleanup-review-form').hidden=row.status!=='pending';$('cleanup-review-choice').value=row.recommendation==='review'?'keep':row.recommendation;$('cleanup-review-check').checked=false;
  $('cleanup-detail-subject').textContent=row.envelope.subject;$('cleanup-detail-sender').textContent=row.envelope.sender+' · '+cleanupDate(row.envelope.receivedAt);
  $('cleanup-detail-reasons').textContent=row.reasons.join(' ');$('cleanup-detail-body').textContent=row.envelope.body;
  $('cleanup-gmail-link').href='https://mail.google.com/mail/u/0/#all/'+encodeURIComponent(row.id);$('cleanup-detail').showModal();
}catch(e){showNotice(e.message,true);}}
$('cleanup-review-form').onsubmit=e=>{e.preventDefault();task(e.submitter,async()=>{if(!cleanupDetailRow||!$('cleanup-review-check').checked)return;await api('cleanup/review',{id:cleanupDetailRow.id,revision:cleanupDetailRow.revision,recommendation:$('cleanup-review-choice').value,reviewed:true});$('cleanup-detail').close();await refresh();showNotice('Your cleanup decision is saved. Gmail is unchanged.');});};
$('cleanup-detail-close').onclick=()=>$('cleanup-detail').close();
document.querySelectorAll('[data-cleanup-filter]').forEach(b=>b.onclick=()=>{cleanupFilter=b.dataset.cleanupFilter;cleanupOffset=0;cleanupSelection.clear();document.querySelectorAll('[data-cleanup-filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));refresh().catch(e=>showNotice(e.message,true));});
$('cleanup-clear').onclick=()=>{cleanupSelection.clear();renderCleanup();};
$('cleanup-settings').onsubmit=e=>{e.preventDefault();task(e.submitter,async()=>{await api('cleanup/settings',{scanLimit:Number($('cleanup-run-limit').value),scanNeuronBudget:Number($('cleanup-run-budget').value),minAgeDays:Number($('cleanup-age').value),minSizeMB:Number($('cleanup-size').value),scope:$('cleanup-scope').value,scheduleDays:Number($('cleanup-schedule').value),backlogThreshold:Number($('cleanup-threshold').value)});await refresh();showNotice('Cleanup options saved. Scheduled reviews only propose actions; they never delete mail.');});};
$('cleanup-scan').onclick=e=>task(e.currentTarget,async()=>{await api('cleanup/scan',{continuous:true,resume:['paused','limited','failed'].includes(state.cleanup.job?.status)});await refresh();showNotice('Scan started. You can leave this page; progress is saved. Model usage appears above. Mailbox changes still require confirmation.');});
$('cleanup-restart').onclick=e=>task(e.currentTarget,async()=>{await api('cleanup/scan',{restart:true,continuous:true});await refresh();showNotice('Fresh cleanup scan started. Existing resolved choices are retained.');});
async function previewCleanup(action){
  const result=await api('cleanup/preview',{action,items:[...cleanupSelection].map(([id,revision])=>({id,revision}))});cleanupApproval=result;
  const descriptions={trash:`Move ${result.items.length} selected messages (${bytes(result.bytes)}) to Gmail Trash. They remain recoverable for up to 30 days, then Gmail permanently deletes them. Trash uses storage until permanent deletion.`,archive:`Archive ${result.items.length} selected messages. Removes Inbox and Spam labels, preserves unread status and other labels. This frees no storage.`,keep:`Keep ${result.items.length} selected messages and dismiss these cleanup proposals locally. Gmail is unchanged, including any Spam label.`,restore:`Remove ${result.items.length} selected messages from Trash. This does not restore their original Inbox placement. You can also restore messages directly in Gmail.`};
  $('cleanup-confirm-title').textContent={trash:'Review deletion',archive:'Review archive',keep:'Keep selected',restore:'Review restore'}[action];
  $('cleanup-confirm-description').textContent=descriptions[action];$('cleanup-confirm-items').replaceChildren();
  result.items.forEach(r=>$('cleanup-confirm-items').append(el('li','',r.subject+' · '+r.sender+' · '+bytes(r.sizeBytes))));
  $('cleanup-confirm-check').checked=false;$('cleanup-confirm-submit').textContent={trash:'Confirm move to Trash',archive:'Confirm archive',keep:'Confirm keep',restore:'Confirm restore'}[action];$('cleanup-confirm').showModal();
}
for(const action of ['keep','archive','trash','restore'])$('cleanup-'+action).onclick=e=>task(e.currentTarget,()=>previewCleanup(action));
$('cleanup-confirm-close').onclick=()=>{$('cleanup-confirm').close();cleanupApproval=null;};
$('cleanup-confirm-form').onsubmit=e=>{e.preventDefault();task(e.submitter,async()=>{
  if(!cleanupApproval||!$('cleanup-confirm-check').checked)return;
  const result=await api('cleanup/apply',{token:cleanupApproval.token,confirmed:true});cleanupApproval=null;cleanupSelection.clear();$('cleanup-confirm').close();await refresh();
  const success=result.results.filter(r=>r.ok).length,failed=result.results.length-success;showNotice(`${success} completed.${failed?' '+failed+' failed; inspect the cleanup list for details.':''}`,!!failed);
});};
async function refreshCleanupPage(){if(cleanupSender&&!state.cleanup.groups.some(g=>g.sender===cleanupSender)){cleanupSender='';cleanupOffset=0;}const page=await api('cleanup/list?filter='+encodeURIComponent(cleanupFilter)+'&sender='+encodeURIComponent(cleanupSender)+'&offset='+cleanupOffset);state.cleanup.items=page.items;state.cleanup.listTotal=page.total;}
refresh=async()=>{await originalRefresh();await refreshCleanupPage();renderWaiting();renderCleanup();renderUsage();renderSubscriptions();lastRefreshAt=Date.now();};
function number(value){return Math.round(value||0).toLocaleString('en-GB');}
function renderUsage(){
  const u=state.usage;if(!u)return;
  $('usage-plan').textContent=`${u.model} · ${u.settings.plan==='workers-paid'?'Workers Paid · $5/month base':'Workers Free'}`;
  $('usage-summary').textContent=`${number(u.today.neurons)} / ${number(u.includedNeurons)} included neurons today · ${u.today.calls} recorded app calls · estimated app share${u.historyIncomplete?' · older usage missing':''}`;
  UI.progress($('usage-progress'),Math.min(u.includedNeurons,u.today.neurons));
  const detail=$('usage-breakdown');detail.replaceChildren();
  for(const text of [
    `Today (UTC): ${number(u.today.tokens)} reported input tokens, ${number(u.today.neurons)} estimated neurons (${u.percentIncluded.toFixed(1)}% of the daily included allocation).`,
    `Daily app budget: ${number(u.settings.dailyNeuronBudget)} neurons; ${number(u.appBudgetRemaining)} available after known usage and reservations.`,
    `This model: $${u.pricing?.dollarsPerMillion||'?'} per million input tokens. Clef has no output-token charge.`,
    `Estimated month-to-date app overage, assuming no other account use: $${u.estimatedMonthlyAppOverageUSD.toFixed(4)}. The $${u.settings.monthlyFeeUSD} base subscription fee is separate.`,
    `Tracking began ${cleanupDate(u.trackedSince)}. ${number(u.legacyTriageTokens)} older triage tokens were recorded separately; earlier cleanup usage cannot be reconstructed.`,
    `${u.today.unknown} calls today have no reported usage yet; ${number(u.today.reserved)} neurons remain reserved for those calls.`,
    u.coverage,'Reviews in this chat use your Codex subscription. This meter tracks Cloudflare calls only.',u.planSource,'Cloudflare account-wide remaining quota is unknown. This meter is not a billing statement.',
    'Rates checked '+u.pricingChecked+'. Daily reset: '+cleanupDate(u.nextResetUTC)
  ])detail.append(el('p','fineprint',text));
  if(!$('usage-dialog').open){$('usage-plan-choice').value=u.settings.plan;$('usage-daily-budget').value=u.settings.dailyNeuronBudget;}
}
$('usage-details').onclick=()=>{renderUsage();$('usage-dialog').showModal();};
$('usage-close').onclick=()=>$('usage-dialog').close();
$('usage-settings').onsubmit=e=>{e.preventDefault();task(e.submitter,async()=>{await api('usage/settings',{plan:$('usage-plan-choice').value,dailyNeuronBudget:Number($('usage-daily-budget').value)});$('usage-dialog').close();await refresh();showNotice('App usage settings saved. Your Cloudflare subscription is unchanged.');});};
$('cleanup-pause').onclick=e=>task(e.currentTarget,async()=>{await api('cleanup/pause',{});await refresh();showNotice('Pause requested. The current request can finish before the scan pauses.');});
$('cleanup-sender').onchange=()=>{cleanupSender=$('cleanup-sender').value;cleanupOffset=0;cleanupSelection.clear();refresh().catch(e=>showNotice(e.message,true));};
$('cleanup-select-visible').onclick=()=>{cleanupSelection.clear();for(const row of state.cleanup.items.filter(r=>['pending','trashed'].includes(r.status)).slice(0,50))cleanupSelection.set(row.id,row.revision);renderCleanup();};
$('cleanup-prev').onclick=()=>{cleanupOffset=Math.max(0,cleanupOffset-100);cleanupSelection.clear();refresh().catch(e=>showNotice(e.message,true));};
$('cleanup-next').onclick=()=>{cleanupOffset+=100;cleanupSelection.clear();refresh().catch(e=>showNotice(e.message,true));};
function renderSubscriptions(){
  const s=state.subscriptions;if(!s)return;
  $('subscription-count').textContent=s.items.length;
  if(!document.querySelector('#subscription-preferences :focus'))$('subscription-review-first').checked=s.preferences.reviewFirst;
  const list=$('subscription-list');const commit=UI.list(list);list.replaceChildren();
  for(const item of s.items){const card=el('article','card subscription-card');card.dataset.key=item.messageId;card.append(el('h3','',item.service),el('p','',item.subject),el('p','hint',item.deadlineDate?'Candidate date: '+item.deadlineDate+' · '+item.kind:'Date needs checking in this chat'),el('p','fineprint','Ask here: “Review the '+item.service+' '+item.kind+' and add cancellation reminders 3 days and 1 day before.”'));
    const link=el('a','','Open source email in Gmail ↗');link.href='https://mail.google.com/mail/u/0/#all/'+encodeURIComponent(item.messageId);link.target='_blank';link.rel='noreferrer';card.append(link);
    const dismiss=el('button','button quiet','Dismiss locally');dismiss.onclick=()=>task(dismiss,async()=>{await api('subscriptions/ack',{messageId:item.messageId,status:'dismissed'});await refresh();});card.append(dismiss);list.append(card);
  }
  commit();if(!s.items.length)empty(list,'No pending subscription reminders.','New trial and renewal emails will appear here. Calendar reminders are handled through this chat.');
}
$('subscription-preferences').onsubmit=e=>{e.preventDefault();task(e.submitter,async()=>{await api('subscriptions/preferences',{reviewFirst:$('subscription-review-first').checked});await refresh();showNotice('Reminder preference saved: 3 days and 1 day before. Calendar actions run through this chat.');});};
let refreshInFlight=false,lastRefreshAt=0;
async function poll(){if(refreshInFlight||$('message-dialog').open||$('cleanup-detail').open||$('cleanup-confirm').open||$('usage-dialog').open)return;if(lastRefreshAt&&Date.now()-lastRefreshAt<(state?.cleanup?.busy?5000:30000))return;refreshInFlight=true;try{await refresh();}catch(e){showNotice('Local server unreachable. Refresh the page if the server was restarted.',true);}finally{refreshInFlight=false;}}
poll();setInterval(poll,5000);
