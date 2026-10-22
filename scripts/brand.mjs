// Generates brand/*.svg and inlines the logo and favicon into public/index.html. Run: node scripts/brand.mjs
// The A is traced from the reference mark; the wordmark is stroke-built so it needs no font.
import fs from 'node:fs';
import { join } from 'node:path';
const root=join(import.meta.dirname,'..');
const INK='#111111',FACET='#c9c9c9',PAPER='#ffffff';
const A_PATH='M28 368 120 95 238 20 355 368H275L258 305 122 318 110 368ZM190 115 125 310 298 207 215 185Z';
const FACET_PATH='M125 310 298 207 146 247Z';
const w=48,base=368,xTop=base-195,cy=(xTop+base)/2,R=97.5-w/2,asc=30;
const f=n=>+n.toFixed(1);
const bowl=cx=>`M${f(cx)} ${f(cy-R)}a${R} ${R} 0 1 0 0.01 0Z`;
const glyphs=[];let x=430;const gap=40;
const add=(width,fn)=>{glyphs.push(fn(x));x+=width+gap;};
const a=l=>{const cx=l+97.5;return bowl(cx)+`M${f(cx+R)} ${xTop}V${base}`;};
add(195,a);
add(195,l=>{const sx=l+24;return `M${sx} ${asc}V${base}`+bowl(sx+R);});
add(195,l=>{const cx=l+97.5,d=R*Math.SQRT1_2;return `M${f(cx-R)} ${cy}H${f(cx+R)}A${R} ${R} 0 1 0 ${f(cx+d)} ${f(cy+d)}`;});
add(308,l=>{const x0=l+24,s=130,r=s/2,c=xTop+w/2+r;return `M${x0} ${xTop}V${base}M${x0} ${c}a${r} ${r} 0 0 1 ${s} 0V${base}M${x0+s} ${c}a${r} ${r} 0 0 1 ${s} 0V${base}`;});
add(195,a);
const iX=x+24;add(48,()=>`M${iX} ${xTop}V${base}`);
const lX=x+24;add(48,()=>`M${lX} ${asc}V${base}`);
const right=x-gap;
const word=glyphs.join('');
const mark=(ink,facet)=>`<path fill="${ink}" fill-rule="evenodd" d="${A_PATH}"/><path fill="${facet}" d="${FACET_PATH}"/>`;
const wm=ink=>`<path fill="none" stroke="${ink}" stroke-width="${w}" d="${word}"/><circle fill="${ink}" cx="${iX}" cy="90" r="28"/>`;
const svg=(vb,body,label='abemail')=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img" aria-label="${label}">${body}</svg>\n`;
const out=join(root,'brand');
fs.writeFileSync(out+'/mark.svg',svg('-6 -6 396 396',mark(INK,FACET)));
fs.writeFileSync(out+'/logo.svg',svg(`0 0 ${right+28} 396`,mark(INK,FACET)+wm(INK)));
fs.writeFileSync(out+'/logo-reversed.svg',svg(`0 0 ${right+28} 396`,mark(PAPER,'#8a8a8a')+wm(PAPER)));
fs.writeFileSync(out+'/app-icon.svg',svg('0 0 512 512',`<rect width="512" height="512" rx="112" fill="${INK}"/><g transform="translate(76 70) scale(.94)">${mark(PAPER,'#9a9a9a')}</g>`));
// Inline the lockup and favicon into the app shell.
const html=join(root,'public','index.html');
{
  const inline=`<svg class="logo" viewBox="0 0 ${right+28} 396" aria-hidden="true">${mark('currentColor',FACET)}${wm('currentColor')}</svg>`;
  const icon=fs.readFileSync(out+'/app-icon.svg','utf8').trim();
  const uri='data:image/svg+xml,'+encodeURIComponent(icon).replace(/'/g,'%27');
  let h=fs.readFileSync(html,'utf8');
  h=h.replace(/<a class="brand"([^>]*)>.*?<\/a>/,`<a class="brand"$1>${inline}</a>`).replace(/<link rel="icon" type="image\/svg\+xml" href="[^"]*">/,`<link rel="icon" type="image/svg+xml" href="${uri}">`);
  fs.writeFileSync(html,h);
}
