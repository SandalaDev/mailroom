import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { questions, parseMessage, modelState, validateAnswers, decide, ruleDecision } from './core.mjs';

export class SecretStore {
  constructor(dir) { this.file=join(dir,'credentials.dpapi'); this.cache=null; }
  crypt(text,decrypt=false) {
    if(process.platform!=='win32') throw new Error('This build uses Windows credential encryption.');
    const script = decrypt
      ? "Add-Type -AssemblyName System.Security; $x=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($x); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))"
      : "Add-Type -AssemblyName System.Security; $x=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($x); $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p))";
    const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input:text,encoding:'utf8',windowsHide:true,timeout:15000});
    if(r.status!==0 || !r.stdout) throw new Error('Windows could not unlock the saved credentials.');
    return r.stdout.trim();
  }
  get() { if(this.cache) return this.cache; this.cache=existsSync(this.file)?JSON.parse(this.crypt(readFileSync(this.file,'utf8'),true)):{}; return this.cache; }
  save(value) { const encrypted=this.crypt(JSON.stringify(value)); writeFileSync(this.file+'.tmp',encrypted,{mode:0o600}); renameSync(this.file+'.tmp',this.file); this.cache=value; }
}

export async function requestJson(url,init={}) {
  const response=await fetch(url,{...init,redirect:'error',signal:init.signal||AbortSignal.timeout(45000)});
  let data; try { data=await response.json(); } catch { throw new Error(`Provider returned invalid JSON (${response.status}).`); }
  if(!response.ok || data.success===false || data.error) {
    const e=new Error(`Provider request failed (${response.status}). Check account access, quota and connection settings.`); e.status=response.status; throw e;
  }
  return data;
}

export class Providers {
  constructor(store,secrets,{request=requestJson,port=4317}={}) { this.store=store;this.secrets=secrets;this.request=request;this.port=port;this.oauth=null;this.refreshing=null; }
  connectionStatus() { const s=this.secrets.get(); return {gmail:!!s.google?.refresh_token,cloudflare:!!(s.cloudflare?.accountId&&s.cloudflare?.token),model:s.cloudflare?.model||'clef',email:s.google?.email||null}; }
  async saveCloudflare(input) {
    if(!/^[a-f0-9]{32}$/i.test(input.accountId||'') || typeof input.token!=='string' || input.token.length<10 || input.token.length>300) throw new Error('Enter a valid Cloudflare account ID and Workers AI token.');
    if(!['clef','clef-flash'].includes(input.model)) throw new Error('Choose a supported Clef model.');
    const cf={accountId:input.accountId,token:input.token,model:input.model};
    // Test only synthetic content before saving credentials or exposing any real email.
    const result=await this.classify({id:'connection-test',sender:'example@example.test',to:'user@example.test',subject:'Weekly example newsletter',body:'A fictional newsletter with no request or deadline.',receivedAt:new Date().toISOString(),hasAttachment:false,incomplete:false},[],this.store.get('policy'),cf);
    this.secrets.save({...this.secrets.get(),cloudflare:cf});
    this.store.event(null,'cloudflare_connected',{model:cf.model,inputTokens:result.inputTokens});
    return {connected:true,model:cf.model};
  }
  oauthStart(credentials) {
    const installed=credentials?.installed;
    if(!installed || typeof installed.client_id!=='string' || !installed.client_id.endsWith('.apps.googleusercontent.com') || typeof installed.client_secret!=='string') throw new Error('Choose the Google OAuth JSON for a Desktop app client.');
    const state=randomBytes(32).toString('base64url'), verifier=randomBytes(48).toString('base64url');
    this.oauth={state,verifier,client_id:installed.client_id,client_secret:installed.client_secret,expires:Date.now()+600000};
    const query=new URLSearchParams({client_id:installed.client_id,redirect_uri:`http://127.0.0.1:${this.port}/oauth/callback`,response_type:'code',scope:'https://www.googleapis.com/auth/gmail.readonly',access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
    return 'https://accounts.google.com/o/oauth2/v2/auth?'+query;
  }
  async oauthFinish(params) {
    const pending=this.oauth;
    const state=params.get('state')||'';
    if(!pending || pending.expires<Date.now() || Buffer.byteLength(state)!==Buffer.byteLength(pending.state) || !timingSafeEqual(Buffer.from(state),Buffer.from(pending.state))) throw new Error('Sign-in expired or state did not match. Start again.');
    this.oauth=null;
    if(params.get('error') || !params.get('code')) throw new Error('Google sign-in was cancelled.');
    const token=await this.request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:params.get('code'),client_id:pending.client_id,client_secret:pending.client_secret,redirect_uri:`http://127.0.0.1:${this.port}/oauth/callback`,grant_type:'authorization_code',code_verifier:pending.verifier})});
    if(!token.refresh_token || !token.access_token) throw new Error('Google did not provide offline access. Reconnect with consent.');
    const profile=await this.request('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:`Bearer ${token.access_token}`}});
    const old=this.secrets.get();
    const existingAccount=old.google?.email||this.store.get('gmail_account');
    if(existingAccount && existingAccount!==profile.emailAddress) throw new Error('This queue belongs to another Gmail account. Use a separate data folder for another account.');
    this.secrets.save({...old,google:{client_id:pending.client_id,client_secret:pending.client_secret,refresh_token:token.refresh_token,access_token:token.access_token,expires_at:Date.now()+token.expires_in*1000,email:profile.emailAddress}});
    this.store.set('gmail_account',profile.emailAddress);
    this.store.event(null,'gmail_connected',{scope:'readonly'});
  }
  async accessToken() {
    const g=this.secrets.get().google;
    if(!g?.refresh_token) throw new Error('Connect Gmail first.');
    if(g.access_token && g.expires_at>Date.now()+60000) return g.access_token;
    if(this.refreshing) return this.refreshing;
    this.refreshing=(async()=>{
      const t=await this.request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:g.client_id,client_secret:g.client_secret,refresh_token:g.refresh_token,grant_type:'refresh_token'})});
      if(!t.access_token) throw new Error('Google access refresh failed. Reconnect Gmail.');
      this.secrets.save({...this.secrets.get(),google:{...g,access_token:t.access_token,expires_at:Date.now()+t.expires_in*1000}}); return t.access_token;
    })();
    try { return await this.refreshing; } finally { this.refreshing=null; }
  }
  async gmail(path,params={}) {
    const token=await this.accessToken();
    return this.request('https://gmail.googleapis.com/gmail/v1/users/me/'+path+'?'+new URLSearchParams(params),{headers:{Authorization:`Bearer ${token}`}});
  }
  async ingest(id) {
    if(this.store.row(id)) return;
    const raw=await this.gmail('messages/'+encodeURIComponent(id),{format:'full'});
    if((raw.labelIds||[]).some(x=>['SPAM','TRASH','DRAFT','SENT'].includes(x))) return;
    this.store.add(parseMessage(raw));
  }
  async sync() {
    let cursor=this.store.get('gmail_cursor');
    if(!cursor) {
      const profile=await this.gmail('profile');
      cursor={phase:'initial',anchor:profile.historyId,query:`after:${Math.floor(Date.now()/1000)-7*86400} -in:spam -in:trash -in:sent -in:drafts`,pageToken:''};
      this.store.set('gmail_cursor',cursor);
    }
    if(cursor.phase==='initial') {
      // Bounded pages per run. Persist the next page only after every ID was ingested.
      for(let page=0;page<3;page++) {
        const data=await this.gmail('messages',{q:cursor.query,maxResults:'100',...(cursor.pageToken?{pageToken:cursor.pageToken}:{})});
        for(const m of data.messages||[]) await this.ingest(m.id);
        if(!data.nextPageToken) { cursor={phase:'history',historyId:cursor.anchor};this.store.set('gmail_cursor',cursor);break; }
        cursor.pageToken=data.nextPageToken;this.store.set('gmail_cursor',cursor);
      }
    } else {
      try {
        const data=await this.gmail('history',{startHistoryId:cursor.historyId,historyTypes:'messageAdded',maxResults:'100',...(cursor.pageToken?{pageToken:cursor.pageToken}:{})});
        for(const h of data.history||[]) for(const item of h.messagesAdded||[]) await this.ingest(item.message.id);
        if(data.nextPageToken) cursor={...cursor,pageToken:data.nextPageToken};
        else cursor={phase:'history',historyId:data.historyId||cursor.historyId};
        this.store.set('gmail_cursor',cursor);
      } catch(e) {
        if(e.status===404) { this.store.set('gmail_cursor',null);this.store.event(null,'history_expired',{recovery:'Seven-day catch-up scheduled; inspect older unprocessed mail manually.'}); }
        throw e;
      }
    }
    this.store.set('sync_status',{at:new Date().toISOString(),phase:cursor.phase,catchingUp:cursor.phase==='initial'||!!cursor.pageToken});
  }
  async context(message) {
    if(!message.isReply) return [];
    const thread=await this.gmail('threads/'+encodeURIComponent(message.threadId),{format:'full'});
    const others=(thread.messages||[]).filter(m=>m.id!==message.id).map(parseMessage).filter(m=>m.receivedAt<=message.receivedAt);
    const selected=others.slice(-4);
    if(!selected.length || others.length>selected.length || selected.some(m=>m.incomplete||m.hasAttachment||m.body.length>1500)) message.incomplete=true;
    return selected.map(m=>({sender:m.sender,subject:m.subject,body:m.body.slice(0,1500),receivedAt:m.receivedAt}));
  }
  async classify(message,context,policy,cf=this.secrets.get().cloudflare) {
    if(!cf?.token) throw new Error('Connect Cloudflare first.');
    const raw=await this.request(`https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/ai/run/@cf/cloudflare/${cf.model}`,{method:'POST',headers:{Authorization:`Bearer ${cf.token}`,'Content-Type':'application/json'},body:JSON.stringify({model:cf.model,state:modelState(message,context,policy),questions:questions()})});
    return validateAnswers(raw);
  }
}

export class Runner {
  constructor(store,providers){this.store=store;this.providers=providers;this.busy=false;}
  async run() {
    if(this.busy) return {busy:true};
    const status=this.providers.connectionStatus();
    if(!status.gmail || !status.cloudflare) return {setupRequired:true};
    this.busy=true;
    const r=this.store.db.prepare('INSERT INTO runs(started_at) VALUES (?)').run(new Date().toISOString());
    const id=Number(r.lastInsertRowid);let processed=0,tokens=0,failed=0;
    try {
      await this.providers.sync();
      const policy=this.store.get('policy');
      for(const row of this.store.pending(policy.maxClassificationsPerRun)) {
        const m=row.envelope;
        try {
          let decision=ruleDecision(m,policy);
          if(!decision) {
            const context=await this.providers.context(m);
            const result=await this.providers.classify(m,context,policy);tokens+=result.inputTokens;
            decision=decide(m,result,policy);
          }
          this.store.classified(m.id,decision,policy.version);processed++;
        } catch { failed++;this.store.failed(m.id); }
      }
      const error=failed?`${failed} message(s) could not be classified and will retry.`:null;
      this.store.db.prepare('UPDATE runs SET finished_at=?,ok=?,processed=?,input_tokens=?,error=? WHERE id=?').run(new Date().toISOString(),failed?0:1,processed,tokens,error,id);
      return {processed,inputTokens:tokens,failed};
    } catch(e) {
      const error=e.message.startsWith('Provider request')?e.message:'Sync failed. Check the Gmail connection and retry.';
      this.store.db.prepare('UPDATE runs SET finished_at=?,ok=0,processed=?,input_tokens=?,error=? WHERE id=?').run(new Date().toISOString(),processed,tokens,error,id);
      this.store.event(null,'run_failed',{error});throw new Error(error);
    } finally {this.busy=false;}
  }
}
