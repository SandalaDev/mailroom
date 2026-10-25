import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Store, dataPath } from './store.mjs';
import { SecretStore, Providers, Runner } from './providers.mjs';
import { validatePolicy } from './core.mjs';
import { loadExamples } from './demo.mjs';
import { Usage } from './usage.mjs';
import { subscriptionsState, trackSubscription, subscriptionReceipt } from './subscriptions.mjs';
import { Cleanup } from './cleanup.mjs';

export function createApp({store=new Store(),providers,port=4317}={}) {
  providers ||= new Providers(store,new SecretStore(dataPath),{port});
  const usage=store.usage ||= new Usage(store);
  for(const row of store.rows({source:'gmail',limit:1000}))trackSubscription(store,row.envelope);
  const runner=new Runner(store,providers);
  const cleanup=new Cleanup(store,providers);
  const key=randomBytes(32).toString('hex');
  const origin=`http://127.0.0.1:${port}`;
  const security={ 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
  const send=(res,status,data)=>{res.writeHead(status,{...security,'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  async function body(req) {
    if(!String(req.headers['content-type']||'').startsWith('application/json')) throw new Error('JSON required.');
    let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>100000)throw new Error('Request too large.');}
    try { return JSON.parse(data||'{}'); } catch { throw new Error('Invalid JSON request.'); }
  }
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.headers.host!==`127.0.0.1:${port}`) return send(res,403,{error:'Local access only.'});
      const url=new URL(req.url,origin);
      if(req.headers.origin && req.headers.origin!==origin) return send(res,403,{error:'Cross-origin access denied.'});
      if(req.method==='GET' && url.pathname==='/oauth/callback') {
        try { await providers.oauthFinish(url.searchParams);res.writeHead(303,{...security,Location:'/?connected=gmail'});res.end(); }
        catch(e){send(res,400,{error:e.message});}return;
      }
      if(url.pathname.startsWith('/api/')) {
        if(req.headers['x-triage-key']!==key) return send(res,403,{error:'Refresh the local app to authorize this request.'});
        if(req.method==='GET' && url.pathname==='/api/state') {
          const rows=store.rows().filter(r=>!r.envelope.labels?.includes('TRASH'));
          return send(res,200,{...store.stats(),connections:providers.connectionStatus(),busy:runner.busy,usage:providers.usageState?providers.usageState():usage.state('',providers.connectionStatus().model||'clef'),subscriptions:subscriptionsState(store),cleanup:cleanup.state(),waiting:store.waiting(),messages:rows.map(r=>({id:r.id,source:r.source,status:r.status,corrected:!!r.corrected,notifiedAt:r.notified_at,error:r.error,decision:r.decision,envelope:{...r.envelope,body:undefined,snippet:r.envelope.securityHint||r.decision?.category==='security'?'Security message: inspect in Gmail.':r.envelope.snippet}}))});
        }
        if(req.method==='GET' && url.pathname==='/api/cleanup/list')return send(res,200,cleanup.list({filter:url.searchParams.get('filter')||'all',sender:url.searchParams.get('sender')||'',offset:Math.max(0,Number(url.searchParams.get('offset'))||0)}));
        if(req.method==='GET' && url.pathname==='/api/operator/message'){const row=cleanup.row(url.searchParams.get('id'))||store.row(url.searchParams.get('id'));if(!row)return send(res,404,{error:'Message not found.'});return send(res,200,{...row,stamp:undefined});}
        if(req.method==='GET' && url.pathname==='/api/operator/report')return send(res,200,{account:providers.connectionStatus().email||null,cleanup:{job:store.get('cleanup_job'),groups:cleanup.groups(),pendingCount:cleanup.state().pendingCount},usage:providers.usageState?providers.usageState():usage.state(''),subscriptions:subscriptionsState(store)});
        if(req.method==='GET' && url.pathname==='/api/message') {
          const row=store.row(url.searchParams.get('id'));if(!row)return send(res,404,{error:'Message not found.'});
          return send(res,200,{...row,revision:store.revision(row)});
        }
        if(req.method==='GET' && url.pathname==='/api/cleanup/message') {
          const row=cleanup.row(url.searchParams.get('id'));if(!row)return send(res,404,{error:'Cleanup message not found.'});
          return send(res,200,{...row,stamp:undefined});
        }
        if(req.method==='POST') {
          const input=await body(req);
          if(url.pathname==='/api/examples') {loadExamples(store);return send(res,200,{loaded:true});}
          if(url.pathname==='/api/cloudflare')return send(res,200,await providers.saveCloudflare(input));
          if(url.pathname==='/api/google')return send(res,200,{url:providers.oauthStart(input,{cleanup:input.cleanup===true})});
          if(url.pathname==='/api/cleanup/settings')return send(res,200,{settings:cleanup.saveSettings(input)});
          if(url.pathname==='/api/usage/settings')return send(res,200,{settings:usage.saveSettings(input)});
          if(url.pathname==='/api/subscriptions/ack')return send(res,200,subscriptionReceipt(store,input));
          if(url.pathname==='/api/subscriptions/preferences'){if(typeof input.reviewFirst!=='boolean')throw new Error('Choose a reminder review preference.');const preferences={daysBefore:[3,1],reviewFirst:input.reviewFirst,timezone:'Africa/Lusaka'};store.set('subscription_preferences',preferences);return send(res,200,{preferences});}
          if(url.pathname==='/api/cleanup/pause')return send(res,200,cleanup.pause());
          if(url.pathname==='/api/cleanup/scan')return send(res,200,cleanup.startScan(input));
          if(url.pathname==='/api/cleanup/preview')return send(res,200,cleanup.preview(input));
          if(url.pathname==='/api/cleanup/review')return send(res,200,await cleanup.review(input));
          if(url.pathname==='/api/cleanup/apply')return send(res,200,await cleanup.apply(input));
          if(url.pathname==='/api/run')return send(res,200,await runner.run());
          if(url.pathname==='/api/policy') {const policy=validatePolicy(input,store.get('policy'));store.set('policy',policy);store.event(null,'policy_changed',{version:policy.version});return send(res,200,{policy});}
          if(url.pathname==='/api/correct') {store.correct(input.id,input.destination);return send(res,200,{saved:true});}
          if(url.pathname==='/api/waiting') {store.waitFor(input.id,input.dueAt);return send(res,200,{saved:true});}
        }
        return send(res,404,{error:'Unknown operation.'});
      }
      const assets={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/tokens.css':['tokens.css','text/css; charset=utf-8'],'/ui.js':['ui.js','text/javascript; charset=utf-8']};
      const asset=assets[url.pathname];
      if(req.method!=='GET'||!asset)return send(res,404,{error:'Not found.'});
      let contents=readFileSync(join(import.meta.dirname,'public',asset[0]),'utf8');
      if(asset[0]==='index.html') contents=contents.replace('APP_SESSION_KEY',key);
      res.writeHead(200,{...security,'Content-Type':asset[1]});res.end(contents);
    } catch(e){send(res,400,{error:e.message||'The request could not be completed.'});}
  });
  return {server,store,runner,cleanup,key,origin};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const port=Number(process.env.TRIAGE_PORT||4317);
  const app=createApp({port});
  app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'Mailroom is already running. Open http://127.0.0.1:'+port:'The local server could not start.');process.exitCode=1;});
  app.server.listen(port,'127.0.0.1',()=>{
    console.log(`Mailroom is ready: ${app.origin}\nObserve mode: no mailbox changes. Close this process to stop background checks.`);
    if(process.argv.includes('--open')&&process.platform==='win32') execFile('rundll32.exe',['url.dll,FileProtocolHandler',app.origin],{windowsHide:true},()=>{});
  });
  const tick=()=>{app.runner.run().catch(()=>{});app.cleanup.tick().catch(()=>{app.store.event(null,'cleanup_schedule_failed',{});});};
  const timer=setInterval(tick,5*60*1000);timer.unref();
  app.server.on('listening',tick);
  function stop(){clearInterval(timer);app.server.close(()=>{app.store.close();process.exit(0);});}
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
