// Interface motion and navigation helpers. Loaded before app.js, which calls window.UI.
// Every helper degrades to an instant update when the user prefers reduced motion.
(()=>{
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE='cubic-bezier(.16,1,.3,1)';
const SPRING='linear(0,.009,.035 2.1%,.141 4.4%,.723 12.9%,.938 16.7%,1.017 19.4%,1.067,1.099 24.3%,1.108 26%,1.099,1.077 30.2%,1.041 35%,1.015 38.5%,.996 43.4%,.991 48%,.997 59.5%,1.001 70.8%,1)';
const $=id=>document.getElementById(id);
const visible=el=>!!(el&&el.offsetParent!==null&&el.getClientRects().length);
const icon=(name,cls='i')=>{const s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('class',cls);const u=document.createElementNS('http://www.w3.org/2000/svg','use');u.setAttribute('href','#'+name);s.append(u);return s;};

// Keyed list FLIP: rows that stay glide to their new place, new rows rise in with a short stagger,
// rows whose data-sig changed flash once. Polling re-renders with no changes produce no motion.
const seen=new WeakMap();
function list(container){
  if(!container)return ()=>{};
  const show=visible(container)&&!reduced();
  const before=new Map();
  if(show)for(const n of container.children)if(n.dataset.key)before.set(n.dataset.key,{top:n.getBoundingClientRect().top,sig:n.dataset.sig});
  const prior=seen.get(container);
  return ()=>{
    const keys=new Map([...container.children].filter(n=>n.dataset.key).map(n=>[n.dataset.key,n.dataset.sig]));
    seen.set(container,keys);
    if(!show){return;}
    let i=0;
    for(const n of container.children){
      const k=n.dataset.key;
      if(!k){if(!prior||prior.size)n.animate([{opacity:0,transform:'translateY(6px)'},{opacity:1,transform:'none'}],{duration:420,easing:EASE});continue;}
      const old=before.get(k);
      if(old){
        const dy=old.top-n.getBoundingClientRect().top;
        if(Math.abs(dy)>1)n.animate([{transform:`translateY(${dy}px)`},{transform:'none'}],{duration:480,easing:SPRING});
        if(old.sig!==n.dataset.sig){n.classList.remove('changed');void n.offsetWidth;n.classList.add('changed');}
      }else if(!prior||!prior.has(k)||!before.size){
        n.animate([{opacity:0,transform:'translateY(8px)',filter:'blur(2px)'},{opacity:1,transform:'none',filter:'blur(0)'}],{duration:460,delay:Math.min(i,12)*24,easing:EASE,fill:'backwards'});
        i++;
      }
    }
  };
}

// Numbers count to their new value and pulse, so a change is noticed without reading every figure.
function count(el,value){
  if(!el)return;
  const to=Number(value)||0,from=el.dataset.v===undefined?0:Number(el.dataset.v);
  el.dataset.v=to;
  if(from===to&&el.textContent!==''){el.textContent=to.toLocaleString('en-GB');return;}
  if(reduced()||!visible(el)){el.textContent=to.toLocaleString('en-GB');return;}
  const start=performance.now(),dur=Math.min(900,380+Math.abs(to-from)*30);
  cancelAnimationFrame(el._raf);
  const step=t=>{const p=Math.min(1,(t-start)/dur),e=1-Math.pow(2,-10*p);el.textContent=Math.round(from+(to-from)*(p===1?1:e)).toLocaleString('en-GB');if(p<1)el._raf=requestAnimationFrame(step);};
  el._raf=requestAnimationFrame(step);
  if(el.dataset.bumped){el.classList.remove('bump');void el.offsetWidth;el.classList.add('bump');}
  el.dataset.bumped='1';
}

function progress(el,value){
  if(!el)return;const to=Number(value)||0,from=Number(el.value)||0;
  if(reduced()||Math.abs(to-from)<1){el.value=to;return;}
  const start=performance.now(),dur=700;cancelAnimationFrame(el._raf);
  const step=t=>{const p=Math.min(1,(t-start)/dur),e=1-Math.pow(1-p,4);el.value=from+(to-from)*e;if(p<1)el._raf=requestAnimationFrame(step);};
  el._raf=requestAnimationFrame(step);
}

// Toast: rises in, a thin bar shows time remaining, hover holds it open.
let toastTimer=null;
function toast(text,error=false){
  const box=$('notice');if(!box)return;
  const wasOpen=!box.hidden;
  box.replaceChildren();box.classList.toggle('error',error);
  const txt=document.createElement('span');txt.className='toast-text';txt.textContent=text;
  const close=document.createElement('button');close.type='button';close.className='toast-close';close.setAttribute('aria-label','Dismiss');close.append(icon('i-x'));
  const bar=document.createElement('span');bar.className='toast-timer';
  box.append(icon(error?'i-alert':'i-check'),txt,close,bar);box.hidden=false;
  const duration=error?9000:5000;
  if(!reduced()){
    if(wasOpen)box.animate([{transform:'scale(1)'},{transform:'scale(1.025)'},{transform:'scale(1)'}],{duration:320,easing:EASE});
    else box.animate([{opacity:0,transform:'translateY(14px) scale(.96)',filter:'blur(4px)'},{opacity:1,transform:'none',filter:'blur(0)'}],{duration:460,easing:SPRING});
    if(error)box.animate([{transform:'translateX(0)'},{transform:'translateX(-5px)'},{transform:'translateX(5px)'},{transform:'translateX(-2px)'},{transform:'translateX(0)'}],{duration:380,delay:120,easing:EASE});
  }
  const timer=bar.animate([{transform:'scaleX(1)'},{transform:'scaleX(0)'}],{duration,easing:'linear',fill:'forwards'});
  clearTimeout(toastTimer);
  const dismiss=()=>{timer.cancel();if(reduced()){box.hidden=true;return;}box.animate([{opacity:1,transform:'none'},{opacity:0,transform:'translateY(10px) scale(.97)'}],{duration:240,easing:EASE}).finished.then(()=>{if(box.contains(bar))box.hidden=true;});};
  timer.finished.then(dismiss).catch(()=>{});
  box.onmouseenter=()=>timer.pause();box.onmouseleave=()=>timer.play();
  close.onclick=dismiss;
}

// Async button feedback: spinner after a short delay (no flicker on fast calls), check on success, shake on failure.
function pending(button){
  if(!button||!button.classList)return {ok(){},fail(){}};
  button.classList.remove('is-done','is-error');
  const t=setTimeout(()=>button.classList.add('is-loading'),140);
  const end=()=>{clearTimeout(t);button.classList.remove('is-loading');};
  return {
    ok(){end();if(reduced()||!visible(button))return;button.classList.add('is-done');setTimeout(()=>button.classList.remove('is-done'),850);},
    fail(){end();void button.offsetWidth;button.classList.add('is-error');setTimeout(()=>button.classList.remove('is-error'),400);}
  };
}

// Sliding indicators for the sidebar and the segmented filter.
function syncNav(){
  const nav=document.querySelector('nav'),ind=nav?.querySelector('.nav-indicator'),active=nav?.querySelector('.nav.active');
  if(!ind||!active||!visible(ind.parentElement))return;
  if(getComputedStyle(ind).display==='none')return;
  ind.style.transform=`translateY(${active.offsetTop}px)`;ind.style.height=active.offsetHeight+'px';
  if(!ind.classList.contains('ready'))requestAnimationFrame(()=>ind.classList.add('ready'));
}
function syncSegmented(root=document){
  for(const seg of root.querySelectorAll('.segmented')){
    const thumb=seg.querySelector('.seg-thumb'),sel=seg.querySelector('.selected');
    if(!thumb||!sel||!visible(seg))continue;
    thumb.style.width=sel.offsetWidth+'px';thumb.style.transform=`translateX(${sel.offsetLeft}px)`;
  }
}

// Direction-aware view change: going down the sidebar slides content up, and the reverse.
const order=()=>[...document.querySelectorAll('.nav[data-view]')].map(n=>n.dataset.view);
let currentView='inbox';
function viewTransition(next,apply){
  const o=order(),dir=o.indexOf(next)<o.indexOf(currentView)?'up':'down';
  const same=next===currentView;currentView=next;
  const done=()=>{apply();const navBtn=document.querySelector(`.nav[data-view="${next}"]`);const use=navBtn?.querySelector('use');const page=$('page-icon')?.querySelector('use');if(use&&page)page.setAttribute('href',use.getAttribute('href'));syncNav();syncSegmented();};
  if(same||reduced()||!document.startViewTransition){done();return;}
  document.documentElement.dataset.dir=dir;
  const vt=document.startViewTransition(done);
  vt.finished.finally(()=>{delete document.documentElement.dataset.dir;$('view-'+next)?.querySelector('.list')&&syncSegmented();});
}

// Command menu (Ctrl/Cmd K or /): pages and actions, arrow keys move a sliding highlight.
const theme=()=>{try{return localStorage.getItem('abemail-theme')}catch{return null}};
function applyTheme(t){if(t)document.documentElement.dataset.theme=t;else delete document.documentElement.dataset.theme;}
applyTheme(theme());
function commands(){
  const pages=[...document.querySelectorAll('.nav[data-view]')].map(n=>({group:'Go to',label:n.querySelector('span').textContent,icon:n.querySelector('use').getAttribute('href').slice(1),kbd:n.dataset.key,run:()=>n.click()}));
  const act=(label,id,iconName,kbd)=>({group:'Actions',label,icon:iconName,kbd,disabled:!$(id)||$(id).disabled,run:()=>$(id)?.click()});
  const dark=document.documentElement.dataset.theme==='dark'||(!document.documentElement.dataset.theme&&matchMedia('(prefers-color-scheme: dark)').matches);
  return [...pages,
    act('Check for new mail','run','i-bolt'),act('Refresh','refresh','i-refresh','R'),act('Load example data','examples','i-inbox'),
    act('Start cleanup scan','cleanup-scan','i-cleanup'),act('Usage details','usage-details','i-gauge'),
    {group:'Preferences',label:dark?'Switch to light theme':'Switch to dark theme',icon:'i-info',run:()=>{const t=dark?'light':'dark';applyTheme(t);try{localStorage.setItem('abemail-theme',t)}catch{}}}];
}
let cmdItems=[],cmdIndex=0;
function renderCmd(){
  const listEl=$('cmdk-list'),q=$('cmdk-input').value.trim().toLowerCase();
  const hl=listEl.querySelector('.cmdk-highlight');listEl.replaceChildren(hl);
  cmdItems=commands().filter(c=>!c.disabled&&c.label.toLowerCase().includes(q));
  let group='';
  cmdItems.forEach((c,i)=>{
    if(c.group!==group){group=c.group;const g=document.createElement('div');g.className='cmdk-group';g.textContent=group;listEl.append(g);}
    const b=document.createElement('button');b.type='button';b.className='cmdk-item';b.setAttribute('role','option');b.dataset.index=i;
    const label=document.createElement('span');label.textContent=c.label;b.append(icon(c.icon),label);
    if(c.kbd){const k=document.createElement('kbd');k.textContent=c.kbd;b.append(k);}
    b.onmousemove=()=>{if(cmdIndex!==i)moveCmd(i);};b.onclick=()=>runCmd(i);listEl.append(b);
  });
  if(!cmdItems.length){const e=document.createElement('div');e.className='cmdk-empty';e.textContent='No matching pages or actions.';listEl.append(e);}
  hl.hidden=!cmdItems.length;moveCmd(0,true);
}
function moveCmd(i,instant=false){
  const listEl=$('cmdk-list'),items=listEl.querySelectorAll('.cmdk-item'),hl=listEl.querySelector('.cmdk-highlight');
  if(!items.length)return;cmdIndex=(i+items.length)%items.length;
  items.forEach((b,j)=>{b.classList.toggle('active',j===cmdIndex);b.setAttribute('aria-selected',String(j===cmdIndex));});
  const target=items[cmdIndex];
  if(instant){hl.style.transition='none';requestAnimationFrame(()=>hl.style.transition='');}
  hl.style.transform=`translateY(${target.offsetTop}px)`;target.scrollIntoView({block:'nearest'});
}
function runCmd(i){const c=cmdItems[i];if(!c)return;$('cmdk').close();setTimeout(()=>c.run(),reduced()?0:200);}
function openCmd(){const d=$('cmdk');if(d.open)return;$('cmdk-input').value='';d.showModal();renderCmd();$('cmdk-input').focus();}

// Keyboard: 1-9 jump to pages, R refreshes, J/K move through rows, Enter opens.
function rows(){const v=document.querySelector('.view:not([hidden])');return v?[...v.querySelectorAll('.message-row')]:[];}
function moveRow(delta){
  const r=rows();if(!r.length)return;let i=r.findIndex(n=>n.classList.contains('kb'));
  r.forEach(n=>n.classList.remove('kb'));i=i<0?0:Math.max(0,Math.min(r.length-1,i+delta));
  r[i].classList.add('kb');r[i].scrollIntoView({block:'nearest',behavior:reduced()?'auto':'smooth'});
}
function typing(e){const t=e.target;return t.closest&&(t.closest('input,textarea,select,[contenteditable]')||document.querySelector('dialog[open]'));}
document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openCmd();return;}
  if($('cmdk')?.open){
    if(e.key==='ArrowDown'){e.preventDefault();moveCmd(cmdIndex+1);}
    else if(e.key==='ArrowUp'){e.preventDefault();moveCmd(cmdIndex-1);}
    else if(e.key==='Enter'){e.preventDefault();runCmd(cmdIndex);}
    return;
  }
  if(typing(e)||e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.key==='/'){e.preventDefault();openCmd();}
  else if(/^[1-9]$/.test(e.key)){document.querySelector(`.nav[data-key="${e.key}"]`)?.click();}
  else if(e.key==='r'){$('refresh')?.click();}
  else if(e.key==='j'||e.key==='ArrowDown'&&rows().some(n=>n.classList.contains('kb'))){e.preventDefault();moveRow(1);}
  else if(e.key==='k'||e.key==='ArrowUp'&&rows().some(n=>n.classList.contains('kb'))){e.preventDefault();moveRow(-1);}
  else if((e.key==='Enter'||e.key==='o')&&rows().some(n=>n.classList.contains('kb'))){e.preventDefault();rows().find(n=>n.classList.contains('kb')).click();}
  else if(e.key==='Escape')rows().forEach(n=>n.classList.remove('kb'));
});

document.addEventListener('DOMContentLoaded',()=>{
  $('cmdk-trigger')?.addEventListener('click',openCmd);
  $('cmdk-input')?.addEventListener('input',renderCmd);
  $('cmdk')?.addEventListener('click',e=>{if(e.target===e.currentTarget)e.currentTarget.close();});
  // Clicking the scrim closes drawers and modals, matching Escape.
  for(const d of document.querySelectorAll('dialog.drawer,dialog.modal'))d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});
  // Metric tiles jump straight to their filter.
  for(const m of document.querySelectorAll('[data-go-filter]'))m.addEventListener('click',()=>document.querySelector(`[data-filter="${m.dataset.goFilter}"]`)?.click());
  for(const b of document.querySelectorAll('[data-filter]'))b.addEventListener('click',()=>requestAnimationFrame(()=>syncSegmented()));
  syncNav();syncSegmented();
  new ResizeObserver(()=>{syncNav();syncSegmented();}).observe(document.body);
});
// Mark the opened row while its drawer is open, so the source stays visible.
document.addEventListener('click',e=>{const row=e.target.closest?.('.message-row');if(!row)return;document.querySelectorAll('.message-row.is-open').forEach(n=>n.classList.remove('is-open'));row.classList.add('is-open');const d=$('message-dialog');d?.addEventListener('close',()=>row.classList.remove('is-open'),{once:true});},true);

window.UI={list,count,progress,toast,pending,syncNav,syncSegmented,viewTransition,icon,busy:on=>document.body.classList.toggle('is-busy',!!on)};
})();
