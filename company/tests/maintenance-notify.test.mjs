import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { notificationText, notificationCard, notifyMaintenance } from '../scripts/maintenance-notify.mjs';

test('中文卡片分组展示版本、变更与验收，乱码发送前拒绝', () => {
  const card = notificationCard({ status: 'installed', summary: '更新完成', notificationDetails: {
    versions: [{ name: 'Magpie', from: '1.0.9', to: '1.0.10' }], changes: ['修复维护进度'], validation: '135 项通过', runtime: '界面已重启，Worker 保持运行',
  } });
  assert.equal(card.schema, '2.0');
  assert.equal(card.header.template, 'green');
  assert.equal(card.body.elements[0].tag, 'column_set');
  assert.match(JSON.stringify(card), /135 项通过/);
  assert.match(JSON.stringify(card), /1.0.9 → \*\*1.0.10/);
  assert.throws(() => notificationCard({ status: 'installed', summary: 'Magpie ???' }), /编码异常/);
});

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
  const run=async spec=>{calls++;assert.ok(spec.args.includes('bot'));assert.ok(spec.args.includes('ou_owner'));assert.ok(spec.args.includes('interactive'));const card=JSON.parse(spec.args[spec.args.indexOf('--content')+1]);assert.match(JSON.stringify(card),/更新完成/);return calls===1?{exitCode:1,stdout:''}:{exitCode:0,stdout:JSON.stringify({ok:true,data:{message_id:'om_test'}})};};
  assert.equal((await notifyMaintenance(root,{config,run})).status,'failed');
  assert.equal((await notifyMaintenance(root,{config,run})).status,'sent');
  assert.equal((await notifyMaintenance(root,{config,run})).status,'sent');
  assert.equal(calls,2);
  assert.equal(JSON.parse(await readFile(path.join(root,'latest.json'),'utf8')).status,'installed');
});
