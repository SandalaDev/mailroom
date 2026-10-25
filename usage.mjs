// Published Cloudflare rates checked 25 October 2026. Estimates, never a provider invoice.
export const AI_PRICING={clef:{neuronsPerMillion:21818,dollarsPerMillion:0.24},'clef-flash':{neuronsPerMillion:3455,dollarsPerMillion:0.038}};
export const INCLUDED_NEURONS=10000;
export class UsageLimitError extends Error {constructor(message){super(message);this.name='UsageLimitError';this.code='USAGE_LIMIT';}}
export class Usage {
  constructor(store) {
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS model_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,finished_at TEXT,account TEXT NOT NULL,
      model TEXT NOT NULL,purpose TEXT NOT NULL,run_id TEXT,input_tokens INTEGER,neurons REAL,
      reserved_neurons REAL NOT NULL,status TEXT NOT NULL);`);
    if(!store.get('usage_tracking_started'))store.set('usage_tracking_started',new Date().toISOString());
  }
  settings(){return {plan:'workers-paid',monthlyFeeUSD:5,dailyNeuronBudget:10000,...this.store.get('usage_settings')};}
  saveSettings(input) {
    const s=this.settings();
    if(input.plan!==undefined){if(!['workers-free','workers-paid'].includes(input.plan))throw new Error('Choose a Workers plan.');s.plan=input.plan;s.monthlyFeeUSD=input.plan==='workers-paid'?5:0;}
    if(input.dailyNeuronBudget!==undefined){if(!Number.isInteger(input.dailyNeuronBudget)||input.dailyNeuronBudget<100||input.dailyNeuronBudget>10000000)throw new Error('Daily app budget must be 100–10,000,000 neurons.');s.dailyNeuronBudget=input.dailyNeuronBudget;}
    this.store.set('usage_settings',s);return s;
  }
  total({account,runId,day}={}) {
    const rows=this.store.db.prepare('SELECT * FROM model_usage WHERE (? IS NULL OR account=?) AND (? IS NULL OR run_id=?) AND (? IS NULL OR substr(at,1,10)=?)').all(account??null,account??null,runId??null,runId??null,day??null,day??null);
    return rows.reduce((s,r)=>({calls:s.calls+1,tokens:s.tokens+(r.input_tokens||0),neurons:s.neurons+(r.neurons||0),reserved:s.reserved+(r.neurons===null?r.reserved_neurons:0),unknown:s.unknown+(r.neurons===null?1:0)}),{calls:0,tokens:0,neurons:0,reserved:0,unknown:0});
  }
  begin({account,model,purpose,runId,runBudget,payload}) {
    const rate=AI_PRICING[model];if(!rate)throw new Error('No usage rate is configured for this model.');
    // UTF-8 bytes provide a conservative token reservation, including the typed questions.
    const reservation=Math.ceil(Buffer.byteLength(JSON.stringify(payload),'utf8')*rate.neuronsPerMillion/1000000);
    const day=new Date().toISOString().slice(0,10),today=this.total({account,day}),s=this.settings();
    const run=runId?this.total({account,runId}):null;
    if(run&&Number.isFinite(runBudget)&&run.neurons+run.reserved+reservation>runBudget)throw new UsageLimitError('This scan reached its model budget. Review the results or increase the scan budget before continuing.');
    if(today.neurons+today.reserved+reservation>s.dailyNeuronBudget)throw new UsageLimitError('Daily app model budget reached. Raise it in Usage details or wait for 00:00 UTC.');
    const result=this.store.db.prepare('INSERT INTO model_usage(at,account,model,purpose,run_id,reserved_neurons,status) VALUES (?,?,?,?,?,?,?)').run(new Date().toISOString(),account,model,purpose,runId||null,reservation,'pending');
    return Number(result.lastInsertRowid);
  }
  finish(id,raw,error=null) {
    const row=this.store.db.prepare('SELECT model FROM model_usage WHERE id=?').get(id);if(!row)return;
    const usage=(raw?.result??raw)?.usage,reported=usage?.input_tokens;
    const tokens=Number.isFinite(reported)&&reported>=0?reported:null;
    const neurons=tokens===null?null:tokens*AI_PRICING[row.model].neuronsPerMillion/1000000;
    this.store.db.prepare('UPDATE model_usage SET finished_at=?,input_tokens=?,neurons=?,status=? WHERE id=?').run(new Date().toISOString(),tokens,neurons,error?'failed':tokens===null?'unknown':'succeeded',id);
  }
  state(account,model='clef') {
    const day=new Date().toISOString().slice(0,10),today=this.total({account,day}),all=this.total({account}),s=this.settings();
    const month=day.slice(0,7);
    const monthRows=this.store.db.prepare('SELECT substr(at,1,10) AS day,SUM(COALESCE(neurons,0)) AS neurons FROM model_usage WHERE account=? AND substr(at,1,7)=? GROUP BY day').all(account||'',month);
    const overage=monthRows.reduce((n,r)=>n+Math.max(0,r.neurons-INCLUDED_NEURONS)*0.011/1000,0);
    const hasCleanup=!!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cleanup_items'").get();
    const historicalCleanup=hasCleanup?this.store.db.prepare('SELECT COUNT(*) AS count FROM cleanup_items WHERE reviewed_at<?').get(this.store.get('usage_tracking_started')).count:0;
    const legacy=this.store.db.prepare('SELECT COALESCE(SUM(input_tokens),0) AS tokens FROM runs WHERE started_at<?').get(this.store.get('usage_tracking_started')).tokens;
    return {settings:s,model,pricing:AI_PRICING[model],today,all,legacyTriageTokens:legacy,historicalCleanupMessages:historicalCleanup,historyIncomplete:legacy>0||historicalCleanup>0,trackedSince:this.store.get('usage_tracking_started'),dayUTC:day,
      includedNeurons:INCLUDED_NEURONS,percentIncluded:today.neurons/INCLUDED_NEURONS*100,
      appBudgetRemaining:Math.max(0,s.dailyNeuronBudget-today.neurons-today.reserved),
      estimatedMonthlyAppOverageUSD:s.plan==='workers-paid'?overage:0,
      accountRemainingNeurons:null,planSource:'Your selected plan; not verified against billing.',
      coverage:'App calls recorded since tracking began. Earlier cleanup calls and other Cloudflare workloads are not included. Token counts come from responses; neuron and cost values are estimates.',
      pricingChecked:'2026-10-25',pricingURL:'https://developers.cloudflare.com/workers-ai/platform/pricing/',
      nextResetUTC:new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString()};
  }
}
