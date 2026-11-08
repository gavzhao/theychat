// 文件接收即删除：全部收件人确认 → 删除；上传时无其他成员 → 首个确认即删；兜底过期
// 频道成员 = 在该频道有游标的 client_id（首次拉取自动入游标，DESIGN §3）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Minio from 'minio';
import { startServer } from './harness.js';

/** 直接查存储：blob 是否还在（本地磁盘或对象存储） */
async function blobExists(env, id) {
  if (!env.THEYCHAT_S3_ENDPOINT) {
    const { existsSync } = await import('node:fs');
    return existsSync(`${env.THEYCHAT_FILES_DIR}/${id}`);
  }
  const u = new URL(env.THEYCHAT_S3_ENDPOINT);
  const mc = new Minio.Client({ endPoint: u.hostname, port: Number(u.port), useSSL: false, accessKey: env.THEYCHAT_S3_ACCESS_KEY, secretKey: env.THEYCHAT_S3_SECRET_KEY });
  try {
    await mc.statObject(env.THEYCHAT_S3_BUCKET, `files/${id}`);
    return true;
  } catch {
    return false;
  }
}

let srv;
// 保留期 2 秒、每秒巡检一次，便于测试过期
before(async () => { srv = await startServer({ THEYCHAT_FILE_TTL_HOURS: String(2 / 3600), THEYCHAT_FILE_GC_SECONDS: '1' }); });
after(async () => { await srv?.stop(); });

const CID = { a: 'lc-a', b: 'lc-b', c: 'lc-c' };
/** 首拉即入游标：有游标 = 频道成员（文件收件人快照按此圈定） */
const join = (clientId, ch) => srv.call('GET', `/v1/channels/${ch}/messages`, { clientId });
const upload = async (clientId, ch, name, from = 'uploader') => {
  const r = await srv.call('POST', `/v1/channels/${ch}/files?name=${name}&from=${from}`, { clientId, body: 'x,y\n1,2\n' });
  assert.equal(r.status, 201, r.text);
  return r.body.file.file_id;
};
const received = (clientId, ch, id) => srv.call('POST', `/v1/channels/${ch}/files/${id}/received`, { clientId });
const download = (clientId, ch, id) => srv.call('GET', `/v1/channels/${ch}/files/${id}`, { clientId });

test('deleted once every member with a cursor at upload time confirms receipt', async () => {
  await srv.call('POST', '/v1/channels', { json: { name: 'trio', from: 'la' } });
  await join(CID.b, 'trio');
  await join(CID.c, 'trio');
  const id = await upload(CID.a, 'trio', 'r.csv', 'la');

  assert.equal((await received(CID.a, 'trio', id)).body.remaining_recipients, 2); // 上传者自己不计数
  assert.equal((await download(CID.b, 'trio', id)).status, 200);
  assert.equal(await blobExists(srv.env, id), true);
  const rb = await received(CID.b, 'trio', id);
  assert.deepEqual([rb.body.deleted, rb.body.remaining_recipients], [false, 1]);
  assert.equal((await received(CID.b, 'trio', id)).body.remaining_recipients, 1); // 幂等
  assert.equal((await download(CID.c, 'trio', id)).status, 200);
  const rc = await received(CID.c, 'trio', id);
  assert.equal(rc.body.deleted, true);
  assert.equal(await blobExists(srv.env, id), false, 'blob removed');

  const gone = await download(CID.c, 'trio', id);
  assert.equal(gone.status, 410);
  assert.equal(gone.body.error.code, 'file_deleted');
  assert.match(gone.body.error.message, /every recipient received it/);

  // 文件消息本身仍在频道日志里（元数据不变）；下载从此永远 410
  const log = await srv.call('GET', '/v1/channels/trio/messages?since=0', { clientId: CID.b });
  const fm = log.body.messages.at(-1);
  assert.equal(fm.content_type, 'application/vnd.theychat.file+json');
  assert.equal(JSON.parse(fm.content).file_id, id);
  assert.equal(fm.sender, 'la');
});

test('uploaded before anyone else had a cursor: first receipt by someone else deletes', async () => {
  await srv.call('POST', '/v1/channels', { json: { name: 'solo' } });
  const id = await upload(CID.a, 'solo', 's.csv');
  await join(CID.b, 'solo'); // 上传后才入游标：不在收件人快照里，但其确认仍计数并触发删除
  assert.equal((await received(CID.b, 'solo', id)).body.deleted, true);
  assert.equal((await download(CID.a, 'solo', id)).status, 410);
});

test('undelivered files expire after the retention period', async () => {
  await srv.call('POST', '/v1/channels', { json: { name: 'slow' } });
  const id = await upload(CID.a, 'slow', 'e.csv'); // 上传时无人有游标 → 无收件人 → 只能等兜底过期
  await join(CID.b, 'slow');
  assert.equal((await download(CID.b, 'slow', id)).status, 200);
  for (let i = 0; i < 50; i++) {
    const r = await download(CID.b, 'slow', id);
    if (r.status === 410) {
      assert.match(r.body.error.message, /expired/);
      assert.equal(await blobExists(srv.env, id), false, 'expired blob removed');
      const info = await srv.call('GET', '/v1/info');
      assert.equal(info.body.file_ttl_seconds, 2);
      return;
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  assert.fail('file did not expire');
});
