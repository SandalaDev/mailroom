import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const allowedPaths=new Set([
  '.gitignore','.gitattributes','package.json','README.md','LICENSE','SECURITY.md','CONTRIBUTING.md','CODEX-RUNBOOK.md',
  'cli.mjs','core.mjs','demo.mjs','providers.mjs','server.mjs','store.mjs','Start Mailroom.cmd','Start Mailroom.ps1',
  'public/app.js','public/index.html','public/style.css','test/mailroom.test.mjs','test/release-check.test.mjs',
  'scripts/release-check.mjs','scripts/ci-template.yml','.githooks/pre-commit'
]);

export function inspectFile(path,buffer,mode='100644') {
  const failures=[];
  if(!allowedPaths.has(path)) failures.push('path is outside the public source allowlist');
  if(!['100644','100755'].includes(mode)) failures.push('symlinks and special file modes are not allowed');
  if(buffer.includes(0)) failures.push('binary content is not allowed');
  const text=buffer.toString('utf8');
  if(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(text)) failures.push('private key marker');
  if(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bAIza[0-9A-Za-z_-]{30,}\b/.test(text)) failures.push('provider credential pattern');
  if(/["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token)["']?\s*[:=]\s*["'][A-Za-z0-9_-]{24,}["']/i.test(text)) failures.push('long credential literal');
  if(/\b[A-Z]:[\\/]Users[\\/][^\s\\/"']+/i.test(text)||/(?:^|[\s"'])\/(?:home|Users)\/[a-z][a-z0-9._-]*\//im.test(text)) failures.push('personal machine path');
  for(const address of text.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)||[]) {
    const domain=address.split('@').at(-1).toLowerCase();
    if(!/^(?:example\.(?:com|org|net)|(?:[a-z0-9-]+\.)*(?:test|invalid|example))$/.test(domain)) failures.push('non-example email address');
  }
  return [...new Set(failures)];
}

export function inspectIndex() {
  const entries=execFileSync('git',['ls-files','--stage','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
  if(!entries.length) throw new Error('Stage the intended public source before running the release check.');
  const failures=[];
  for(const entry of entries){
    const match=entry.match(/^(\d+) ([a-f0-9]+) (\d)\t(.+)$/s);
    if(!match||match[3]!=='0')throw new Error('Resolve index conflicts before publication.');
    const [,mode,,,path]=match;
    const content=execFileSync('git',['show',':'+path],{maxBuffer:2*1024*1024});
    const issues=inspectFile(path,content,mode);
    if(issues.length) failures.push({path,issues});
  }
  return {files:entries.length,failures};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]) {
  try {
    const result=inspectIndex();
    if(result.failures.length){console.error(JSON.stringify(result,null,2));process.exitCode=1;}
    else console.log(`Public-source check passed for ${result.files} staged files. No blocked patterns found. Manual review is still required.`);
  }catch(e){console.error(e.message);process.exitCode=1;}
}
