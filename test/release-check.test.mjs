import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectFile } from '../scripts/release-check.mjs';

test('release gate rejects email databases, encrypted secrets, reports and archives',()=>{
  for(const path of ['data/triage.sqlite','data/credentials.dpapi','mail-export.json','screenshot.png','Mailroom.zip'])assert.ok(inspectFile(path,Buffer.from('data')).length>0);
});
test('release gate permits reserved example addresses and rejects real-address shaped content',()=>{
  assert.deepEqual(inspectFile('README.md',Buffer.from('hello@example.test')),[]);
  assert.ok(inspectFile('README.md',Buffer.from('someone@'+'mail-provider.com')).includes('non-example email address'));
});
test('release gate rejects provider keys, literal long tokens, symlinks and binary contents',()=>{
  assert.ok(inspectFile('core.mjs',Buffer.from('ghp_'+'A'.repeat(36))).includes('provider credential pattern'));
  assert.ok(inspectFile('core.mjs',Buffer.from('token="'+'B'.repeat(40)+'"')).includes('long credential literal'));
  assert.ok(inspectFile('core.mjs',Buffer.from('file'), '120000').length>0);
  assert.ok(inspectFile('core.mjs',Buffer.from([1,0,2])).includes('binary content is not allowed'));
});
test('release gate distinguishes API resource paths from personal home directories',()=>{
  assert.deepEqual(inspectFile('providers.mjs',Buffer.from('https://gmail.googleapis.com/gmail/v1/users/me/profile')),[]);
  const machinePath='C:'+String.fromCharCode(92)+'Users'+String.fromCharCode(92)+'example-user';
  assert.ok(inspectFile('README.md',Buffer.from(machinePath)).includes('personal machine path'));
});
