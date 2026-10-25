import { createHash, randomBytes } from 'node:crypto';
import { trackSubscription } from './subscriptions.mjs';
import { parseMessage, senderAddress, decide } from './core.mjs';

const DAY=86400000;
export const CLEANUP_DEFAULTS={minAgeDays:180,minSizeMB:0,scope:'all',scheduleDays:0,backlogThreshold:0,scanLimit:1000,scanNeuronBudget:10000};
const COPY={
  old:'Included by your minimum-age filter (no maximum age).', unwanted:'Sender is on your unwanted list.',
  spam:'Gmail currently labels this message as Spam.', important:'Sender is on your important list.',
  flagged:'Starred or marked important in Gmail.', record:'May be a financial, legal, security, or other important record.',
  context:'Attachments or incomplete context need human inspection.', conversation:'Part of a conversation; inspect before discarding.',
  project:'Mentions an active project.', action:'May require your attention, action, or a deadline.',
  uncertain:'The classifier could not safely recommend hiding this message.',
  disposable:'Clef identified unwanted content and all retention checks passed.',
  reference:'Clef identified retained reference or later-reading content; archiving frees no storage.',
  failed:'Classification failed. Retained for manual review; scan again to retry.',
  recent:'Too recent for this cleanup policy.', local:'You already corrected or tracked this message locally.'
};
export function validateCleanupSettings(input,previous=CLEANUP_DEFAULTS) {
  if(!input||typeof input!=='object')throw new Error('Cleanup settings are required.');
  const next={...previous};
  for(const [key,min,max] of [['scanLimit',20,100000],['scanNeuronBudget',100,10000000],['minAgeDays',0,36500],['minSizeMB',0,1000],['scheduleDays',0,365],['backlogThreshold',0,500]]) {
    if(input[key]!==undefined){if(!Number.isInteger(input[key])||input[key]<min||input[key]>max)throw new Error(`Invalid ${key}.`);next[key]=input[key];}
  }
  if(input.scope!==undefined){if(!['all','spam'].includes(input.scope))throw new Error('Choose all mail or Spam.');next.scope=input.scope;}
  return next;
}
export function cleanupQuery(settings,now=Date.now()) {
  const cutoff=Math.floor((now-settings.minAgeDays*DAY)/1000);
  return `${settings.minAgeDays?`before:${cutoff} `:''}-in:trash -in:sent -in:drafts${settings.scope==='spam'?' in:spam':''}${settings.minSizeMB?` larger:${settings.minSizeMB*1024*1024}`:''}`;
}
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const snapshotStamp=(raw,thread,local=null)=>hash({raw,thread,local});

export function recommendCleanup(message,decision,policy,settings,thread=[],now=Date.now(),localProtected=false) {
  const reasons=[];
  const age=(now-Date.parse(message.receivedAt))/DAY;
  if(!Number.isFinite(age)||age<settings.minAgeDays)return {recommendation:'keep',reasons:[COPY.recent]};
  reasons.push(COPY.old);
  if(localProtected)return {recommendation:'keep',reasons:[...reasons,COPY.local]};
  if(policy.importantSenders.includes(senderAddress(message.sender)))return {recommendation:'keep',reasons:[...reasons,COPY.important]};
  if(message.labels.some(x=>['STARRED','IMPORTANT'].includes(x)))return {recommendation:'keep',reasons:[...reasons,COPY.flagged]};
  if([message,...thread].some(m=>m.protectedHint||m.securityHint)||['financial','security'].includes(decision?.category)||decision?.retention==='yes')return {recommendation:'keep',reasons:[...reasons,COPY.record]};
  if(message.hasAttachment||message.incomplete||thread.some(m=>m.hasAttachment||m.incomplete))return {recommendation:'review',reasons:[...reasons,COPY.context]};
  if(message.isReply||thread.length)return {recommendation:'review',reasons:[...reasons,COPY.conversation]};
  const text=(message.subject+'\n'+message.body).toLowerCase();
  if(policy.projects.some(p=>text.includes(p.toLowerCase())))return {recommendation:'review',reasons:[...reasons,COPY.project]};
  if(!decision)return {recommendation:'review',reasons:[...reasons,COPY.failed]};
  if(decision.destination==='needs-you'||decision.action==='yes'||decision.deadline==='yes'||['urgent','today'].includes(decision.urgency))return {recommendation:'keep',reasons:[...reasons,COPY.action]};
  if(decision.destination==='review'||decision.retention!=='no')return {recommendation:'review',reasons:[...reasons,COPY.uncertain,...(decision.reasons||[]).map(x=>x.replaceAll('_',' '))]};
  const unwanted=policy.unwantedSenders.includes(senderAddress(message.sender));
  const spam=message.labels.includes('SPAM');
  if(unwanted)reasons.push(COPY.unwanted);
  if(spam)reasons.push(COPY.spam);
  if(decision.destination==='holding'&&(unwanted||spam||['promotion','newsletter','notification'].includes(decision.category)))return {recommendation:'delete',reasons:[...reasons,COPY.disposable]};
  if(['archive','digest'].includes(decision.destination))return {recommendation:'archive',reasons:[...reasons,COPY.reference]};
  return {recommendation:'review',reasons:[...reasons,COPY.uncertain]};
}

export class Cleanup {
  constructor(store,providers) {
    this.store=store;this.providers=providers;this.busy=false;this.approvals=new Map();this.active=null;
    store.db.exec(`CREATE TABLE IF NOT EXISTS cleanup_items (
      id TEXT PRIMARY KEY, envelope TEXT NOT NULL, stamp TEXT NOT NULL, recommendation TEXT NOT NULL,
      reasons TEXT NOT NULL, policy_version INTEGER NOT NULL, reviewed_at TEXT NOT NULL,
      revision TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, manual INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cleanup_actions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, action TEXT NOT NULL,
      at TEXT NOT NULL, size_bytes INTEGER NOT NULL, receipt TEXT NOT NULL);`);
    if(!store.db.prepare('PRAGMA table_info(cleanup_items)').all().some(c=>c.name==='manual'))store.db.exec('ALTER TABLE cleanup_items ADD COLUMN manual INTEGER NOT NULL DEFAULT 0');
    const interrupted=store.get('cleanup_job');if(interrupted?.status==='running'||interrupted?.status==='pausing')store.set('cleanup_job',{...interrupted,status:'paused',reason:'Server restarted. Resume to continue from the saved checkpoint.'});
    store.db.prepare("UPDATE cleanup_items SET status='uncertain',error='The server stopped during this action. Inspect Gmail before further action.' WHERE status='acting'").run();
  }
  settings(){return {...CLEANUP_DEFAULTS,...this.store.get('cleanup_settings')};}
  saveSettings(input) {
    if(this.busy)throw new Error('Wait for the current cleanup operation to finish.');
    const previous=this.settings(),next=validateCleanupSettings(input,previous);
    if(['minAgeDays','minSizeMB','scope'].some(k=>next[k]!==previous[k])) {
      this.store.set('cleanup_cursor',null);
      this.store.db.prepare("UPDATE cleanup_items SET policy_version=0,error='Scan options changed. Scan again before acting.' WHERE status='pending'").run();
    }
    if(next.scheduleDays!==previous.scheduleDays||next.backlogThreshold!==previous.backlogThreshold)this.store.set('cleanup_schedule_check',null);
    this.store.set('cleanup_settings',next);this.approvals.clear();
    this.store.event(null,'cleanup_settings_changed',next);return next;
  }
  row(id){const r=this.store.db.prepare('SELECT * FROM cleanup_items WHERE id=?').get(id);return r?{...r,envelope:JSON.parse(r.envelope),reasons:JSON.parse(r.reasons)}:null;}
  rows({compact=false}={}){return this.store.db.prepare("SELECT *,"+(compact?"json_remove(envelope,'$.body','$.snippet')":'envelope')+" AS envelope FROM cleanup_items ORDER BY reviewed_at DESC").all().map(r=>({...r,envelope:JSON.parse(r.envelope),reasons:JSON.parse(r.reasons)}));}
  list({filter='all',sender='',offset=0,limit=100}={}){const rows=this.rows({compact:true}).filter(r=>(filter==='history'?r.status!=='pending':r.status==='pending'&&(filter==='all'||r.recommendation===filter))&&(!sender||senderAddress(r.envelope.sender)===sender));return {total:rows.length,offset,items:rows.slice(offset,offset+limit).map(r=>({...r,stamp:undefined,stale:r.policy_version!==this.store.get('policy').version}))};}
  groups(){const groups=new Map();for(const r of this.rows({compact:true}).filter(r=>r.status==='pending')){const sender=senderAddress(r.envelope.sender),g=groups.get(sender)||{sender,count:0,bytes:0,recommendations:{},ids:[],subjects:[]};g.count++;g.bytes+=r.envelope.sizeBytes||0;g.recommendations[r.recommendation]=(g.recommendations[r.recommendation]||0)+1;if(g.ids.length<20)g.ids.push(r.id);if(g.subjects.length<3)g.subjects.push(r.envelope.subject);groups.set(sender,g);}return [...groups.values()].sort((a,b)=>b.count-a.count);}
  state() {
    const rows=this.rows({compact:true}),pending=rows.filter(r=>r.status==='pending'),cursor=this.store.get('cleanup_cursor');
    return {settings:this.settings(),busy:this.busy,job:this.store.get('cleanup_job'),scan:this.store.get('cleanup_scan'),hasMore:!!cursor?.pageToken,
      pendingCount:pending.length,potentialBytes:pending.filter(r=>r.recommendation==='delete'&&r.policy_version===this.store.get('policy').version).reduce((n,r)=>n+r.envelope.sizeBytes,0),
      groups:this.groups(),items:rows.slice(0,200).map(r=>({...r,stamp:undefined,envelope:{...r.envelope,body:undefined,snippet:undefined},stale:r.policy_version!==this.store.get('policy').version})),
      history:this.store.db.prepare('SELECT * FROM cleanup_actions ORDER BY seq DESC LIMIT 30').all()};
  }
  protectLocal(id) {return !!this.store.row(id)?.corrected||!!this.store.db.prepare('SELECT 1 FROM waiting WHERE message_id=? AND resolved_at IS NULL').get(id);}
  async inspect(id) {
    const raw=await this.providers.gmail('messages/'+encodeURIComponent(id),{format:'full'});
    if(raw.id!==id)throw new Error('Gmail returned a different message.');
    const message=parseMessage(raw);
    const thread=await this.providers.gmail('threads/'+encodeURIComponent(message.threadId),{format:'full'});
    if(!Array.isArray(thread.messages)||!thread.messages.some(m=>m.id===id))throw new Error('Conversation context was unavailable.');
    const others=thread.messages.filter(m=>m.id!==id).map(parseMessage);
    if(others.length>4)message.incomplete=true;
    const bytes=Number(raw.sizeEstimate);
    message.sizeBytes=Number.isFinite(bytes)&&bytes>0?Math.floor(bytes):0;
    return {message,others,raw,thread,stamp:snapshotStamp(raw,thread,{revision:this.store.row(id)?this.store.revision(this.store.row(id)):null,waiting:this.store.db.prepare('SELECT due_at FROM waiting WHERE message_id=? AND resolved_at IS NULL').get(id)||null})};
  }
  startScan({restart=false,continuous=true,resume=false}={}) {
    if(this.busy)return {busy:true};
    const status=this.providers.connectionStatus();if(!status.gmail||!status.cloudflare)throw new Error('Connect Gmail and Clef before scanning.');
    if(restart)this.store.set('cleanup_cursor',null);
    this.busy=true;this.pauseRequested=false;
    const previous=this.store.get('cleanup_job'),settings=this.settings();
    const job={id:randomBytes(16).toString('hex'),status:'running',continuous,startedAt:new Date().toISOString(),
      visited:resume?previous?.visited||0:0,processed:resume?previous?.processed||0:0,failed:resume?previous?.failed||0:0,skipped:resume?previous?.skipped||0:0,
      runLimit:settings.scanLimit,runVisited:0,neuronBudget:settings.scanNeuronBudget,policyVersion:this.store.get('policy').version};
    this.store.set('cleanup_job',job);
    this.active=(continuous?this.runContinuous(job):this.scan()).catch(()=>{}).finally(()=>{this.busy=false;this.active=null;});
    return {started:true};
  }
  pause() {
    if(this.busy&&!this.active)throw new Error('Wait for the current mailbox action to finish.');
    this.pauseRequested=true;
    const job=this.store.get('cleanup_job');
    if(job?.status==='running')this.store.set('cleanup_job',{...job,status:this.busy?'pausing':'paused',reason:'Pause requested. An in-flight request may finish first.'});
    return {saved:true};
  }
  async runContinuous(job) {
    const settings=this.settings(),policy=structuredClone(this.store.get('policy'));
    let cursor=this.store.get('cleanup_cursor');
    if(!cursor||cursor.complete)cursor={query:cleanupQuery(settings),pageToken:'',pendingIds:[]};
    const save=(status='running',reason=null)=>{
      const model=this.providers.usage?.total({runId:job.id});
      this.store.set('cleanup_cursor',cursor);
      this.store.set('cleanup_job',{...job,status,reason,updatedAt:new Date().toISOString(),modelUsage:model||null});
      this.store.set('cleanup_scan',{startedAt:job.startedAt,finishedAt:status==='running'?null:new Date().toISOString(),processed:job.processed,failed:job.failed,error:reason});
    };
    let consecutiveFailures=0;
    try {
      while(true) {
        if(this.pauseRequested){save('paused','Paused. Resume continues from this checkpoint.');return;}
        if(this.store.get('policy').version!==job.policyVersion){save('paused','Rules changed. Start or resume a scan under the current rules.');return;}
        if(job.runVisited>=job.runLimit){save('limited',`Review limit of ${job.runLimit} messages reached. Continue when ready.`);return;}
        if(!cursor.pendingIds?.length) {
          if(cursor.pageLoaded&&!cursor.nextPageToken){cursor.complete=true;save('completed');return;}
          if(cursor.pageLoaded)cursor.pageToken=cursor.nextPageToken;
          const page=await this.providers.gmail('messages',{q:cursor.query,includeSpamTrash:'true',maxResults:'100',...(cursor.pageToken?{pageToken:cursor.pageToken}:{})});
          cursor={...cursor,pendingIds:(page.messages||[]).map(m=>m.id),nextPageToken:page.nextPageToken||'',pageLoaded:true};job.estimatedMatches=page.resultSizeEstimate||job.estimatedMatches||null;save();
          if(!cursor.pendingIds.length){if(cursor.nextPageToken)continue;cursor.complete=true;save('completed');return;}
        }
        const id=cursor.pendingIds[0];
        try {
          const existing=this.row(id);
          if(existing&&(existing.status!=='pending'||(existing.policy_version===policy.version&&!existing.error)))job.skipped++;
          else {
            const {message,others,stamp}=await this.inspect(id);
            if(message.labels.some(x=>['TRASH','SENT','DRAFT'].includes(x)))job.skipped++;
            else {
              trackSubscription(this.store,message);
              let decision=null,error=null;
              const guarded=recommendCleanup(message,null,policy,settings,others,Date.now(),this.protectLocal(id));
              if(guarded.reasons.includes(COPY.failed)) {
                try {
                  const context=others.slice(-4).map(m=>({sender:m.sender,subject:m.subject,body:m.body.slice(0,1500),receivedAt:m.receivedAt}));
                  const result=await this.providers.classify(message,context,policy,undefined,{purpose:'cleanup',runId:job.id,runBudget:job.neuronBudget});
                  decision=decide(message,result,policy);consecutiveFailures=0;
                } catch(e){if(e.code==='USAGE_LIMIT'){save('limited',e.message);return;}error='Classifier unavailable; ask Codex to review this message.';consecutiveFailures++;job.failed++;}
              }
              const recommendation=recommendCleanup(message,decision,policy,settings,others,Date.now(),this.protectLocal(id));
              message.cleanupEvidence=decision?{probability:decision.probability,margin:decision.margin,category:decision.category,proposedDestination:decision.answers?.destination?.choice}:null;
              this.store.db.prepare(`INSERT INTO cleanup_items(id,envelope,stamp,recommendation,reasons,policy_version,reviewed_at,revision,status,error)
                VALUES (?,?,?,?,?,?,?,?,'pending',?) ON CONFLICT(id) DO UPDATE SET envelope=excluded.envelope,stamp=excluded.stamp,
                recommendation=excluded.recommendation,reasons=excluded.reasons,policy_version=excluded.policy_version,
                reviewed_at=excluded.reviewed_at,revision=excluded.revision,error=excluded.error,manual=0`).run(id,JSON.stringify(message),stamp,recommendation.recommendation,JSON.stringify(recommendation.reasons),policy.version,new Date().toISOString(),randomBytes(16).toString('hex'),error);
              job.processed++;
            }
          }
        } catch(e){job.failed++;consecutiveFailures++;this.store.event(id,'cleanup_message_failed',{});}
        cursor.pendingIds.shift();job.visited++;job.runVisited++;save();
        if(consecutiveFailures>=3){save('paused','Three provider failures in a row. Check the connection before resuming.');return;}
      }
    } catch(e){save('failed','Scan stopped after a provider error. The checkpoint is saved; resume to retry.');this.store.event(null,'cleanup_scan_failed',{});}
    finally {this.store.event(null,'cleanup_run_finished',{visited:job.visited,processed:job.processed,failed:job.failed});}
  }
  async scan() {
    const settings=this.settings(),policy=structuredClone(this.store.get('policy'));
    const prior=this.store.get('cleanup_cursor');
    const cursor=prior?.pageToken?prior:{query:cleanupQuery(settings),pageToken:''};
    const startedAt=new Date().toISOString();let processed=0,failed=0;
    this.store.set('cleanup_scan',{startedAt,processed,failed});
    try {
      // Each batch is bounded. The same query/cursor survives restarts until the batch succeeds.
      const page=await this.providers.gmail('messages',{q:cursor.query,includeSpamTrash:'true',maxResults:'20',...(cursor.pageToken?{pageToken:cursor.pageToken}:{})});
      for(const item of page.messages||[]) {
        try {
          const existing=this.row(item.id);
          if(existing&&existing.status!=='pending')continue;
          if(existing?.policy_version===policy.version&&!existing.error)continue;
          const {message,others,stamp}=await this.inspect(item.id);
          if(message.labels.some(x=>['TRASH','SENT','DRAFT'].includes(x)))continue;
          trackSubscription(this.store,message);
          let decision=null,error=null;
          const obvious=recommendCleanup(message,null,policy,settings,others,Date.now(),this.protectLocal(item.id));
          if(obvious.recommendation!=='keep') {
            try {
              const context=others.slice(-4).map(m=>({sender:m.sender,subject:m.subject,body:m.body.slice(0,1500),receivedAt:m.receivedAt}));
              const result=await this.providers.classify(message,context,policy,undefined,{purpose:'cleanup'});
              decision=decide(message,result,policy);
            } catch {error='Classifier unavailable; manual review required.';failed++;}
          }
          const recommendation=recommendCleanup(message,decision,policy,settings,others,Date.now(),this.protectLocal(item.id));
          this.store.db.prepare(`INSERT INTO cleanup_items(id,envelope,stamp,recommendation,reasons,policy_version,reviewed_at,revision,status,error)
            VALUES (?,?,?,?,?,?,?,?,'pending',?) ON CONFLICT(id) DO UPDATE SET envelope=excluded.envelope,stamp=excluded.stamp,
            recommendation=excluded.recommendation,reasons=excluded.reasons,policy_version=excluded.policy_version,
            reviewed_at=excluded.reviewed_at,revision=excluded.revision,error=excluded.error,manual=0`).run(item.id,JSON.stringify(message),stamp,recommendation.recommendation,JSON.stringify(recommendation.reasons),policy.version,new Date().toISOString(),randomBytes(16).toString('hex'),error);
          processed++;
          this.store.set('cleanup_scan',{startedAt,processed,failed});
        } catch {failed++;}
      }
      // Don't advance a page with failures: successful IDs deduplicate on the retry.
      this.store.set('cleanup_cursor',failed?cursor:{query:cursor.query,pageToken:page.nextPageToken||'',complete:!page.nextPageToken});
      this.store.set('cleanup_scan',{startedAt,finishedAt:new Date().toISOString(),processed,failed,hasMore:!!page.nextPageToken,error:failed?'Some messages need another scan to retry.':null});
      this.store.event(null,'cleanup_scanned',{processed,failed});
    } catch(e) {
      this.store.set('cleanup_scan',{startedAt,finishedAt:new Date().toISOString(),processed,failed,error:'Cleanup scan failed. Check connections and retry.'});
      this.store.event(null,'cleanup_scan_failed',{});throw e;
    }
  }
  async review({id,revision,recommendation,reviewed}) {
    if(this.busy)throw new Error('Wait for the current cleanup operation to finish.');
    if(reviewed!==true||!['keep','archive','delete'].includes(recommendation))throw new Error('Inspect the message and confirm your review first.');
    const row=this.row(id);
    if(!row||row.status!=='pending'||row.revision!==revision)throw new Error('This proposal changed. Refresh and inspect it again.');
    this.busy=true;
    try {
      const current=await this.inspect(id);
      if(current.stamp!==row.stamp)throw new Error('Message or conversation changed. Scan again and inspect the updated proposal.');
      if(current.message.labels.some(x=>['TRASH','SENT','DRAFT'].includes(x)))throw new Error('This message is no longer eligible. Inspect it in Gmail.');
      const reasons=[`You reviewed this message and chose ${recommendation}.`,...row.reasons];
      this.store.db.prepare('UPDATE cleanup_items SET envelope=?,stamp=?,recommendation=?,reasons=?,policy_version=?,reviewed_at=?,revision=?,error=NULL,manual=1 WHERE id=?')
        .run(JSON.stringify(current.message),current.stamp,recommendation,JSON.stringify(reasons),this.store.get('policy').version,new Date().toISOString(),randomBytes(16).toString('hex'),id);
      this.approvals.clear();this.store.event(id,'cleanup_reviewed',{recommendation});
      return {saved:true};
    } finally {this.busy=false;}
  }
  async tick() {
    const s=this.settings(),status=this.providers.connectionStatus();
    if(this.busy||!s.scheduleDays||!status.gmail||!status.cloudflare)return;
    const last=this.store.get('cleanup_schedule_check');
    if(last&&Date.now()-Date.parse(last)<s.scheduleDays*DAY)return;
    this.store.set('cleanup_schedule_check',new Date().toISOString());
    if(s.backlogThreshold) {
      // Count real IDs, not Gmail's approximate resultSizeEstimate, before triggering a review.
      const page=await this.providers.gmail('messages',{q:cleanupQuery(s),includeSpamTrash:'true',maxResults:String(s.backlogThreshold)});
      if((page.messages||[]).length<s.backlogThreshold)return;
    }
    this.startScan();
  }
  preview({action,items},{issueToken=true}={}) {
    if(this.busy)throw new Error('Wait for the current cleanup operation to finish.');
    if(!['keep','archive','trash','restore'].includes(action)||!Array.isArray(items)||!items.length||items.length>50||new Set(items.map(x=>x.id)).size!==items.length)throw new Error('Select 1 to 50 distinct messages and a valid action.');
    if(action!=='keep') {
      if(!this.providers.connectionStatus().gmailModify)throw new Error('Reconnect Gmail with cleanup permission first.');
      if(this.store.get('policy').mode!=='organize')throw new Error('Enable Organize mode in Rules before changing Gmail.');
    }
    const policyVersion=this.store.get('policy').version;
    const rows=items.map(item=>{
      const row=this.row(item.id);
      if(!row||row.revision!==item.revision)throw new Error('A selection changed. Refresh the cleanup list.');
      if(row.status!==(action==='restore'?'trashed':'pending'))throw new Error('A selected message is no longer available for this action.');
      if(!['keep','restore'].includes(action)&&(row.policy_version!==policyVersion||(!row.manual&&this.protectLocal(row.id))))throw new Error('Rules or local corrections changed. Scan again before acting.');
      if(action==='trash'&&row.recommendation!=='delete')throw new Error('Only Delete recommendations can be moved to Trash.');
      if(action==='archive'&&row.recommendation!=='archive')throw new Error('Only Archive recommendations can be archived.');
      return row;
    });
    if(!issueToken)return rows;
    const token=randomBytes(32).toString('hex');
    for(const [key,value] of this.approvals)if(value.expires<Date.now())this.approvals.delete(key);
    this.approvals.set(token,{action,items:rows.map(r=>({id:r.id,revision:r.revision})),policyVersion,expires:Date.now()+10*60000});
    return {token,action,items:rows.map(r=>({id:r.id,subject:r.envelope.subject,sender:r.envelope.sender,sizeBytes:r.envelope.sizeBytes})),bytes:rows.reduce((n,r)=>n+r.envelope.sizeBytes,0)};
  }
  async apply({token,confirmed}) {
    if(confirmed!==true)throw new Error('Explicit confirmation is required.');
    if(this.busy)throw new Error('A cleanup operation is already running.');
    const approval=this.approvals.get(token);this.approvals.delete(token);
    if(!approval||approval.expires<Date.now())throw new Error('Confirmation expired or already used. Review the selection again.');
    if(approval.policyVersion!==this.store.get('policy').version)throw new Error('Rules changed. Review the selection again.');
    this.preview(approval,{issueToken:false}); // Recheck local eligibility without issuing another confirmation.
    this.busy=true;
    const results=[];
    try {
      for(const item of approval.items) {
        const row=this.row(item.id);
        try {
          if(approval.action!=='keep') {
            const current=await this.inspect(row.id);
            if(current.stamp!==row.stamp)throw new Error('Message or conversation changed. Scan again before acting.');
            if(approval.policyVersion!==this.store.get('policy').version||this.store.get('policy').mode!=='organize'||!this.providers.connectionStatus().gmailModify||(approval.action!=='restore'&&!row.manual&&this.protectLocal(row.id)))throw new Error('Permissions, rules, or local corrections changed. Review again.');
          }
          // Persist intent before the network call; ambiguous failures are never blindly retried.
          this.store.db.prepare("UPDATE cleanup_items SET status='acting',error=NULL WHERE id=?").run(row.id);
          let receipt={id:row.id,local:true},status='kept';
          if(approval.action!=='keep') {
            receipt=await this.providers.cleanupAction(row.id,approval.action);
            status={trash:'trashed',archive:'archived',restore:'restored'}[approval.action];
          }
          const at=new Date().toISOString();
          this.store.db.exec('BEGIN IMMEDIATE');
          try {
            this.store.db.prepare('UPDATE cleanup_items SET status=?,revision=?,error=NULL WHERE id=?').run(status,randomBytes(16).toString('hex'),row.id);
            this.store.db.prepare('INSERT INTO cleanup_actions(message_id,action,at,size_bytes,receipt) VALUES (?,?,?,?,?)').run(row.id,approval.action,at,row.envelope.sizeBytes,JSON.stringify({id:receipt.id,historyId:receipt.historyId||null}));
            this.store.event(row.id,'cleanup_'+approval.action,{sizeBytes:row.envelope.sizeBytes});
            const local=this.store.row(row.id);
            if(local&&approval.action!=='keep') {
              local.envelope.labels=receipt.labelIds;local.envelope.cleanupStatus=status;
              this.store.db.prepare('UPDATE messages SET envelope=? WHERE id=?').run(JSON.stringify(local.envelope),row.id);
            }
            this.store.db.exec('COMMIT');
          } catch(e) {this.store.db.exec('ROLLBACK');throw e;}
          if(status==='trashed') {
            // Snapshot the provider-confirmed post-action state for a separately confirmed restore.
            try {const current=await this.inspect(row.id);this.store.db.prepare('UPDATE cleanup_items SET stamp=?,envelope=? WHERE id=?').run(current.stamp,JSON.stringify(current.message),row.id);}catch {this.store.db.prepare('UPDATE cleanup_items SET error=? WHERE id=?').run('Restore snapshot unavailable. Restore this message in Gmail.',row.id);}
          }
          results.push({id:row.id,ok:true,status});
        } catch(e) {
          const acting=this.row(row.id)?.status==='acting';
          const error=acting?'Outcome uncertain. Inspect this message in Gmail before further action.':e.message;
          this.store.db.prepare('UPDATE cleanup_items SET status=?,error=? WHERE id=?').run(acting?'uncertain':row.status,error,row.id);
          this.store.event(row.id,'cleanup_action_failed',{action:approval.action,uncertain:acting});
          results.push({id:row.id,ok:false,error});
        }
      }
      // A mutation changes Gmail pagination. Start a fresh query next time; resolved IDs deduplicate.
      if(approval.action!=='keep')this.store.set('cleanup_cursor',null);
      return {results};
    } finally {this.busy=false;}
  }
}
