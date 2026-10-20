import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { notificationText, notifyMaintenance } from '../scripts/maintenance-notify.mjs';

test('无更新不通知；安装成功与待确认消息保留具体摘要', () => {
  assert.equal(notificationText({status:'up-to-date'}), null);
  assert.match(notificationText({status:'installed',summary:'1.0.10：更新网关'}), /1.0.10：更新网关/);
  assert.match(notificationText({status:'blocked',summary:'请选择保留旧接口还是迁移'}), /请选择保留旧接口还是迁移/);
});
test('固定 Bot 收件人、失败可重试、成功去重，通知不改变安装结果', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'maintenance-notify-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'latest.json'),JSON.stringify({status:'installed',summary:'更新完成',completedAt:'2026-10-20T00:00:00Z'}));
  const config={enabled:true,profile:'cli_demo',userId:'ou_owner',cliEntry:'fixture.js'};
  let calls=0;
  const run=async spec=>{calls++;assert.ok(spec.args.includes('bot'));assert.ok(spec.args.includes('ou_owner'));return calls===1?{exitCode:1,stdout:''}:{exitCode:0,stdout:JSON.stringify({ok:true,data:{message_id:'om_test'}})};};
  assert.equal((await notifyMaintenance(root,{config,run})).status,'failed');
  assert.equal((await notifyMaintenance(root,{config,run})).status,'sent');
  assert.equal((await notifyMaintenance(root,{config,run})).status,'sent');
  assert.equal(calls,2);
  assert.equal(JSON.parse(await readFile(path.join(root,'latest.json'),'utf8')).status,'installed');
});
