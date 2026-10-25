import { ensureSubscriptionTables, trackSubscription } from './subscriptions.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_POLICY, DESTINATIONS } from './core.mjs';
export const dataPath = resolve(process.env.TRIAGE_DATA_DIR || join(import.meta.dirname,'data'));
export class Store {
  constructor(path = dataPath) {
    mkdirSync(path,{recursive:true});
    this.db = new DatabaseSync(join(path,'triage.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,source TEXT NOT NULL,envelope TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',decision TEXT,policy_version INTEGER,classified_at TEXT,corrected INTEGER NOT NULL DEFAULT 0,notified_at TEXT,error TEXT,next_retry TEXT,attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,message_id TEXT,kind TEXT NOT NULL,detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (message_id TEXT NOT NULL,revision TEXT NOT NULL,kind TEXT NOT NULL,at TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(message_id,revision,kind));
      CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT,started_at TEXT NOT NULL,finished_at TEXT,ok INTEGER,processed INTEGER NOT NULL DEFAULT 0,input_tokens INTEGER NOT NULL DEFAULT 0,error TEXT);
      CREATE TABLE IF NOT EXISTS waiting (thread_id TEXT PRIMARY KEY,message_id TEXT NOT NULL,due_at TEXT NOT NULL,started_at TEXT NOT NULL,resolved_at TEXT);
      CREATE INDEX IF NOT EXISTS messages_status ON messages(status);`);
    ensureSubscriptionTables(this);
    if (!this.get('policy')) this.set('policy', DEFAULT_POLICY);
  }
  get(key) { const row=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  set(key,value) { this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)); }
  event(id,kind,detail={}) { this.db.prepare('INSERT INTO events(at,message_id,kind,detail) VALUES (?,?,?,?)').run(new Date().toISOString(),id,kind,JSON.stringify(detail)); }
  add(message,source='gmail') {
    const r=this.db.prepare('INSERT OR IGNORE INTO messages(id,thread_id,source,envelope) VALUES (?,?,?,?)').run(message.id,message.threadId,source,JSON.stringify(message));
    if(r.changes) {
      this.event(message.id,'received',{source});
      trackSubscription(this,message,source);
      if(source==='gmail') {
        const w=this.db.prepare('SELECT * FROM waiting WHERE thread_id=? AND resolved_at IS NULL').get(message.threadId);
        if(w && message.receivedAt>w.started_at) {this.db.prepare('UPDATE waiting SET resolved_at=? WHERE thread_id=?').run(new Date().toISOString(),message.threadId);this.event(message.id,'reply_received',{});}
      }
    }
    return !!r.changes;
  }
  row(id) { const r=this.db.prepare('SELECT * FROM messages WHERE id=?').get(id); return r ? this.unpack(r) : null; }
  unpack(r) { return {...r,envelope:JSON.parse(r.envelope),decision:r.decision?JSON.parse(r.decision):null}; }
  rows({source,limit=500}={}) { return this.db.prepare('SELECT * FROM messages WHERE (? IS NULL OR source=?) ORDER BY json_extract(envelope,\'$.receivedAt\') DESC LIMIT ?').all(source??null,source??null,limit).map(r=>this.unpack(r)); }
  pending(limit=50) { return this.db.prepare("SELECT * FROM messages WHERE source='gmail' AND status='pending' AND (next_retry IS NULL OR next_retry<=?) ORDER BY rowid LIMIT ?").all(new Date().toISOString(),limit).map(r=>this.unpack(r)); }
  classified(id,decision,version) {
    const at=new Date().toISOString();
    const r=this.db.prepare("UPDATE messages SET status='classified',decision=?,policy_version=?,classified_at=?,error=NULL,next_retry=NULL WHERE id=? AND corrected=0").run(JSON.stringify(decision),version,at,id);
    if(r.changes) this.event(id,'classified',{destination:decision.destination,version});
  }
  failed(id) {
    const row=this.row(id); if(!row) return;
    const delay=Math.min(3600,60*2**Math.min(row.attempts,6));
    this.db.prepare("UPDATE messages SET error='Classification failed; retry scheduled.',attempts=attempts+1,next_retry=? WHERE id=?").run(new Date(Date.now()+delay*1000).toISOString(),id);
    this.event(id,'classification_failed',{});
  }
  correct(id,destination) {
    if(!DESTINATIONS.includes(destination)) throw new Error('Invalid destination.');
    const row=this.row(id); if(!row) throw new Error('Message not found.');
    const decision={...(row.decision||{}),destination,origin:'user',reasons:['manual_correction']};
    const at=new Date().toISOString();
    this.db.prepare("UPDATE messages SET decision=?,status='classified',corrected=1,policy_version=?,classified_at=?,notified_at=NULL WHERE id=?").run(JSON.stringify(decision),this.get('policy').version,at,id);
    this.event(id,'corrected',{previous:row.decision?.destination||null,destination});
  }
  revision(row) { return `${row.policy_version || 0}:${row.classified_at}`; }
  waitFor(id,dueAt) {
    const row=this.row(id); if(!row) throw new Error('Message not found.');
    const due=new Date(dueAt);if(!Number.isFinite(due.getTime()))throw new Error('Choose a valid follow-up date.');
    this.db.prepare('INSERT INTO waiting(thread_id,message_id,due_at,started_at,resolved_at) VALUES (?,?,?,?,NULL) ON CONFLICT(thread_id) DO UPDATE SET message_id=excluded.message_id,due_at=excluded.due_at,started_at=excluded.started_at,resolved_at=NULL').run(row.thread_id,id,due.toISOString(),new Date().toISOString());
    this.event(id,'follow_up_set',{dueAt:due.toISOString()});
  }
  waiting() {return this.db.prepare('SELECT * FROM waiting WHERE resolved_at IS NULL ORDER BY due_at').all().map(w=>({...w,overdue:Date.parse(w.due_at)<=Date.now(),subject:this.row(w.message_id)?.envelope.subject||'',source:this.row(w.message_id)?.source}));}
  auditSample(limit=20) { return this.db.prepare("SELECT id FROM messages WHERE source='gmail' AND status='classified' AND COALESCE(json_extract(envelope,'$.cleanupStatus'),'') NOT IN ('trashed','archived') AND json_extract(decision,'$.destination') IN ('archive','holding','digest') ORDER BY RANDOM() LIMIT ?").all(limit).map(r=>{const row=this.row(r.id);return {id:row.id,threadId:row.thread_id,subject:row.envelope.subject,destination:row.decision.destination,revision:this.revision(row),source:'gmail'};}); }
  queue() {
    const policy=this.get('policy');
    const pending=this.db.prepare(`SELECT m.* FROM messages m WHERE source='gmail' AND status='classified'
      AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.message_id=m.id AND a.revision=CAST(COALESCE(m.policy_version,0) AS TEXT)||':'||m.classified_at AND a.kind IN ('notified','archived'))
      ORDER BY CASE json_extract(decision,'$.destination') WHEN 'needs-you' THEN 0 WHEN 'review' THEN 1 ELSE 2 END, classified_at ASC`).all().map(r=>this.unpack(r)).filter(r=>!r.envelope.labels?.includes('TRASH')&&!['trashed','archived'].includes(r.envelope.cleanupStatus));
    return pending.map(r=>({id:r.id,threadId:r.thread_id,revision:this.revision(r),policyVersion:r.policy_version,currentPolicyVersion:policy.version,stalePolicy:r.policy_version!==policy.version,sender:r.envelope.sender,subject:r.envelope.subject,
      // Security-related message bodies and codes must never enter queue previews.
      preview:r.envelope.securityHint||r.decision?.category==='security'?'Security message: inspect in Gmail.':r.envelope.snippet,
      receivedAt:r.envelope.receivedAt,decision:r.decision,mode:policy.mode,notifiedAt:r.notified_at,
      actions:this.db.prepare('SELECT kind,at FROM actions WHERE message_id=? AND revision=?').all(r.id,this.revision(r)),url:`https://mail.google.com/mail/u/0/#all/${r.id}`}));
  }
  acknowledge({id,revision,kind,receipt}) {
    const row=this.row(id); if(!row || row.source!=='gmail') throw new Error('Live message not found.');
    if(this.revision(row)!==revision) throw new Error('Stale decision. Read the queue again.');
    if(row.policy_version!==this.get('policy').version && kind!=='notified') throw new Error('Policy changed. Re-review this decision before acting.');
    if(!['notified','labeled','archived','restored'].includes(kind)) throw new Error('Action not allowed.');
    if(kind==='archived' && (this.get('policy').mode!=='organize' || !['archive','holding','digest'].includes(row.decision?.destination))) throw new Error('Archiving is not permitted by the current policy.');
    if(kind!=='notified' && this.get('policy').mode!=='organize') throw new Error('Observe mode permits no mailbox changes.');
    if(typeof receipt!=='string'||receipt.length<5||receipt.length>2000) throw new Error('A confirmation receipt is required.');
    const at=new Date().toISOString();
    const r=this.db.prepare('INSERT OR IGNORE INTO actions(message_id,revision,kind,at,receipt) VALUES (?,?,?,?,?)').run(id,revision,kind,at,receipt);
    if(r.changes) { if(kind==='notified') this.db.prepare('UPDATE messages SET notified_at=? WHERE id=?').run(at,id); this.event(id,'action_confirmed',{kind,receipt}); }
    return {recorded:!!r.changes};
  }
  stats() {
    const counts=this.db.prepare('SELECT source,status,COUNT(*) AS count FROM messages GROUP BY source,status').all();
    const lastRun=this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get()||null;
    const backlog=this.db.prepare("SELECT COUNT(*) as count,MIN(json_extract(envelope,'$.receivedAt')) AS oldest FROM messages WHERE source='gmail' AND status='pending'").get();
    const recentEvents=this.db.prepare('SELECT at,message_id,kind,detail FROM events ORDER BY seq DESC LIMIT 30').all().map(e=>({...e,detail:JSON.parse(e.detail)}));
    return {counts,lastRun,backlog,recentEvents,policy:this.get('policy'),sync:this.get('sync_status')};
  }
  close(){ this.db.close(); }
}
