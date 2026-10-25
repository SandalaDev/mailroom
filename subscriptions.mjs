import { senderAddress } from './core.mjs';

export const REMINDER_DEFAULTS={daysBefore:[3,1],reviewFirst:true,timezone:'Africa/Lusaka'};
const MONTHS=['january','february','march','april','may','june','july','august','september','october','november','december'];
function exactDate(text) {
  const matches=[];
  for(const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g))matches.push({date:`${m[1]}-${m[2]}-${m[3]}`,evidence:m[0]});
  const month='('+MONTHS.map(m=>m+'|'+m.slice(0,3)).join('|')+')';
  const patterns=[new RegExp('\\b'+month+'\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(20\\d{2})\\b','gi'),new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+'+month+'[,]?\\s+(20\\d{2})\\b','gi')];
  patterns.forEach((pattern,i)=>{for(const m of text.matchAll(pattern)){const monthName=m[i===0?1:2].toLowerCase(),monthIndex=MONTHS.findIndex(x=>x===monthName||x.slice(0,3)===monthName)+1;matches.push({date:`${m[3]}-${String(monthIndex).padStart(2,'0')}-${m[i===0?2:1].padStart(2,'0')}`,evidence:m[0]});}});
  const valid=matches.filter(m=>{const d=new Date(m.date+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===m.date;});
  const unique=[...new Set(valid.map(m=>m.date))];
  return unique.length===1?valid[0]:{date:null,evidence:unique.length?'Multiple dates: inspect the email.':'No single explicit full date found.'};
}
export function subscriptionCandidate(message) {
  const text=(message.subject+'\n'+message.body).slice(0,18000);
  if(!/your\s+(?:\w+\s+){0,3}(?:trial|subscription)|trial\s+(?:ends|expires|ending)|subscription\s+(?:renews|renewal|confirmed|activated)|next\s+(?:billing|payment|charge)\s+(?:date|on|is)|you(?:'re| are)\s+subscribed/i.test(text))return null;
  // A whole email can contain purchase dates and deadlines. Multiple dates remain ambiguous.
  const deadline=exactDate(text);
  return {messageId:message.id,service:senderAddress(message.sender).split('@').at(-1),sender:message.sender,subject:message.subject,
    kind:/trial/i.test(text)?'trial':'subscription',deadlineDate:deadline.date,evidence:deadline.evidence,
    receivedAt:message.receivedAt};
}
export function ensureSubscriptionTables(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS subscriptions (
    message_id TEXT PRIMARY KEY,candidate TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'needs_review',
    detected_at TEXT NOT NULL,calendar_event_id TEXT,calendar_id TEXT);`);
}
export function trackSubscription(store,message,source='gmail') {
  if(source!=='gmail')return;
  const candidate=subscriptionCandidate(message);if(!candidate)return;
  // Old cleanup mail must not create reminders for years-old purchases or offers.
  if(Date.now()-Date.parse(message.receivedAt)>90*86400000&&!candidate.deadlineDate)return;
  if(candidate.deadlineDate&&candidate.deadlineDate<new Date().toISOString().slice(0,10))return;
  store.db.prepare('INSERT OR IGNORE INTO subscriptions(message_id,candidate,detected_at) VALUES (?,?,?)').run(message.id,JSON.stringify(candidate),new Date().toISOString());
}
export function subscriptionsState(store) {
  return {preferences:{...REMINDER_DEFAULTS,...store.get('subscription_preferences')},items:store.db.prepare("SELECT * FROM subscriptions WHERE status='needs_review' ORDER BY detected_at DESC LIMIT 100").all().map(r=>({...JSON.parse(r.candidate),status:r.status,detectedAt:r.detected_at}))};
}
export function subscriptionReceipt(store,{messageId,status,eventId,calendarId}) {
  if(!['calendar_added','dismissed'].includes(status))throw new Error('Invalid subscription status.');
  if(status==='calendar_added'&&(typeof eventId!=='string'||!eventId||typeof calendarId!=='string'||!calendarId))throw new Error('A confirmed Calendar event ID and calendar ID are required.');
  const r=store.db.prepare('UPDATE subscriptions SET status=?,calendar_event_id=?,calendar_id=? WHERE message_id=?').run(status,eventId||null,calendarId||null,messageId);
  if(!r.changes)throw new Error('Subscription candidate not found.');
  store.event(messageId,'subscription_'+status,{eventId:eventId||null});return {saved:true};
}
