import { readFileSync } from 'node:fs';
import { Store } from './store.mjs';
const store=new Store();
try {
  const command=process.argv[2]||'health';
  let output;
  if(command==='queue') {const queue=store.queue();output={mode:store.get('policy').mode,maxFullReads:store.get('policy').maxCodexReads,total:queue.length,remaining:Math.max(0,queue.length-200),items:queue.slice(0,200)};}
  else if(command==='health') {
    const s=store.stats();const stale=!s.lastRun?.finished_at||Date.now()-Date.parse(s.lastRun.finished_at)>15*60000;
    output={...s,account:store.get('gmail_account'),stale,setupRequired:!s.lastRun,notice:s.lastRun?'A quiet inbox does not prove health. Inspect stale or failed runs.':'Connections have not yet completed a run.'};
  } else if(command==='message') {
    const row=store.row(process.argv[3]);if(!row||row.source!=='gmail')throw new Error('Live message not found.');
    output={...row,revision:store.revision(row)};
  } else if(command==='ack') {
    // Read structured data from stdin, never interpolate email content into a shell command.
    output=store.acknowledge(JSON.parse(readFileSync(0,'utf8')));
  } else if(command==='audit') {
    output={sample:store.auditSample(),corrections:store.rows({source:'gmail'}).filter(r=>r.corrected).map(r=>({id:r.id,subject:r.envelope.subject,decision:r.decision}))};
  } else if(command==='waiting') output={items:store.waiting().filter(x=>x.source==='gmail')};
  else if(command==='digest') {
    output={candidates:store.queue().filter(x=>!x.notifiedAt&&['needs-you','digest','review'].includes(x.decision.destination))};
  } else throw new Error('Use health, queue, message <id>, digest, audit, waiting or ack (JSON on stdin).');
  console.log(JSON.stringify(output,null,2));
} catch(e){console.error(e.message);process.exitCode=1;}finally{store.close();}
