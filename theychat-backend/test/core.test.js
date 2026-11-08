// 核心协议回归：频道、消息、长轮询、游标（client_id 隔离）、ACK 钳制、since 回放、文件交换
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startServer } from './harness.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });

const CID_A = 'client-alice';
const CID_B = 'client-bob';

test('info + channels create/list (X-Client-Id optional on the list)', async () => {
  const info = await srv.call('GET', '/v1/info');
  assert.equal(info.status, 200);
  assert.match(info.body.instance_id, /^srv_/);
  assert.equal(info.body.max_file_bytes, 1024);
  assert.equal('registration' in info.body, false);

  const r = await srv.call('POST', '/v1/channels', { json: { name: 'room', from: 'alice' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.name, 'room');
  assert.equal(r.body.created_by, 'alice');
  assert.equal(typeof r.body.created_at, 'number');

  assert.equal((await srv.call('POST', '/v1/channels', { json: { name: 'room' } })).status, 409);
  const quiet = await srv.call('POST', '/v1/channels', { json: { name: 'quiet' } });
  assert.equal(quiet.status, 201);
  assert.equal(quiet.body.created_by, null);
  assert.equal((await srv.call('POST', '/v1/channels', { json: { name: 'bad name' } })).status, 422);

  // 不带头：只有 latest_seq 等公共字段
  const anon = await srv.call('GET', '/v1/channels');
  assert.equal(anon.status, 200);
  const anonRoom = anon.body.channels.find((c) => c.name === 'room');
  assert.equal(anonRoom.latest_seq, 0);
  assert.equal('my_cursor' in anonRoom, false);
  assert.equal('pending' in anonRoom, false);

  // 带头：附自己视角的游标 / 积压（还没有游标 → null）
  const mine = await srv.call('GET', '/v1/channels', { clientId: CID_A });
  const mineRoom = mine.body.channels.find((c) => c.name === 'room');
  assert.equal(mineRoom.my_cursor, null);
  assert.equal(mineRoom.pending, null);
});

test('messages, seq, cursor isolation, ack clamp, long-poll, since replay, reply_to', async () => {
  // 频道不隐式创建：404
  assert.equal((await srv.call('POST', '/v1/channels/nope/messages', { json: { content: 'x' } })).status, 404);
  assert.equal((await srv.call('GET', '/v1/channels/nope/messages', { clientId: CID_A })).status, 404);

  // 并发写入：seq 严格连续无空洞
  const sends = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    srv.call('POST', '/v1/channels/room/messages', { json: { content: `m${i}`, from: 'alice' } })));
  const seqs = sends.map((r) => r.body.seq).sort((x, y) => x - y);
  assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.ok(sends.every((r) => r.body.sender === 'alice'));

  // B 首次拉取：游标初始化（§5），看到全部消息；有游标即成为频道成员
  const r1 = await srv.call('GET', '/v1/channels/room/messages', { clientId: CID_B });
  assert.equal(r1.body.cursor_initialized, true);
  assert.equal(r1.body.messages.length, 20);
  assert.equal(r1.body.messages[0].sender, 'alice');
  assert.equal(r1.body.cursor, 0);

  // ACK 钳制到 latest_seq；只进不退
  const ack = await srv.call('POST', '/v1/channels/room/ack', { clientId: CID_B, json: { through: 999 } });
  assert.equal(ack.body.cursor, 20);
  const back = await srv.call('POST', '/v1/channels/room/ack', { clientId: CID_B, json: { through: 3 } });
  assert.equal(back.body.cursor, 20);

  // 游标按 (channel, client_id) 隔离：A 的游标与 B 互不可见
  const ackA = await srv.call('POST', '/v1/channels/room/ack', { clientId: CID_A, json: { through: 2 } });
  assert.equal(ackA.body.cursor, 2);
  const curB = await srv.call('GET', '/v1/channels/room/cursor', { clientId: CID_B });
  assert.equal(curB.body.cursor, 20);
  assert.equal(curB.body.client_id, CID_B);
  const curA = await srv.call('GET', '/v1/channels/room/cursor', { clientId: CID_A });
  assert.equal(curA.body.cursor, 2);

  // 长轮询：写入后立即唤醒；reply_to 线程引用
  const t0 = Date.now();
  const waiting = srv.call('GET', '/v1/channels/room/messages?wait=10', { clientId: CID_B });
  await new Promise((r) => setTimeout(r, 300));
  await srv.call('POST', '/v1/channels/room/messages', { json: { content: 'wake', reply_to: 1 } });
  const w = await waiting;
  assert.equal(w.body.messages[0].content, 'wake');
  assert.equal(w.body.messages[0].reply_to, 1);
  assert.ok(Date.now() - t0 < 3000, 'long-poll should wake promptly');

  // 空等超时
  const e = await srv.call('GET', '/v1/channels/room/messages?wait=1&since=21', { clientId: CID_B });
  assert.equal(e.body.messages.length, 0);

  // since 显式回放：纯读，不动游标
  const replay = await srv.call('GET', '/v1/channels/room/messages?since=0&limit=1000', { clientId: CID_B });
  assert.equal(replay.body.messages.length, 21);
  assert.equal((await srv.call('GET', '/v1/channels/room/cursor', { clientId: CID_B })).body.cursor, 20);

  // 频道列表：B 欠 1 条（pending）
  const list = await srv.call('GET', '/v1/channels', { clientId: CID_B });
  const room = list.body.channels.find((c) => c.name === 'room');
  assert.equal(room.latest_seq, 21);
  assert.equal(room.pending, 1);

  // 422：reply_to 指向不存在的 seq
  assert.equal((await srv.call('POST', '/v1/channels/room/messages', { json: { content: 'x', reply_to: 99 } })).status, 422);
  // 413：消息过大
  assert.equal((await srv.call('POST', '/v1/channels/room/messages', { json: { content: 'x'.repeat(64 * 1024 + 1) } })).status, 413);
  // 422：文件消息 content_type 只能由 POST /files 产生，POST /messages 拒收（防伪造）
  const forged = await srv.call('POST', '/v1/channels/room/messages',
    { json: { content: '{}', content_type: 'application/vnd.theychat.file+json' } });
  assert.equal(forged.status, 422);
});

test('X-Client-Id required where it matters; from is self-reported', async () => {
  // 缺头 → 400 missing_client_id（五个端点）
  for (const r of [
    await srv.call('GET', '/v1/channels/room/messages'),
    await srv.call('POST', '/v1/channels/room/ack', { json: { through: 1 } }),
    await srv.call('GET', '/v1/channels/room/cursor'),
    await srv.call('POST', '/v1/channels/room/files?name=x.csv', { body: 'a,b\n' }),
    await srv.call('POST', '/v1/channels/room/files/f_x/received'),
  ]) {
    assert.equal(r.status, 400, r.text);
    assert.equal(r.body.error.code, 'missing_client_id');
  }
  // 格式非法 → 400
  const bad = await srv.call('GET', '/v1/channels/room/messages', { clientId: 'bad id!' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid_client_id');
  assert.equal((await srv.call('GET', '/v1/channels', { clientId: 'bad id!' })).status, 400);

  // from：缺省 "anon"；trim；越界 / 类型错误 422
  const d = await srv.call('POST', '/v1/channels/room/messages', { json: { content: 'who?' } });
  assert.equal(d.status, 201);
  assert.equal(d.body.sender, 'anon');
  const t = await srv.call('POST', '/v1/channels/room/messages', { json: { content: 'hi', from: '  bob  ' } });
  assert.equal(t.status, 201);
  assert.equal(t.body.sender, 'bob');
  assert.equal((await srv.call('POST', '/v1/channels/room/messages', { json: { content: 'x', from: '' } })).status, 422);
  assert.equal((await srv.call('POST', '/v1/channels/room/messages', { json: { content: 'x', from: 'x'.repeat(65) } })).status, 422);
  assert.equal((await srv.call('POST', '/v1/channels/room/messages', { json: { content: 'x', from: 42 } })).status, 422);
  // 文件上传同样自报 from（query 参数）
  const uf = await srv.call('POST', '/v1/channels/room/files?name=f.csv&from=%20%20carol%20%20', { clientId: CID_A, body: 'a,b\n' });
  assert.equal(uf.status, 201);
  assert.equal(uf.body.file.from, 'carol');
});

test('file exchange', async () => {
  await srv.call('POST', '/v1/channels', { json: { name: 'files' } });
  const data = Buffer.from('id,value\n1,hello\n2,世界\n');
  const up = await srv.call('POST', '/v1/channels/files/files?name=' + encodeURIComponent('结果.csv') + '&caption=hi&from=alice',
    { clientId: CID_A, body: data, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(up.status, 201, up.text);
  assert.equal(up.body.file.mime, 'text/csv');
  assert.equal(up.body.file.from, 'alice');
  assert.equal(up.body.file.sha256, createHash('sha256').update(data).digest('hex'));
  assert.equal(up.body.sender, 'alice');
  // 下载不需要 X-Client-Id
  const dl = await fetch(`${srv.url}/v1/channels/files/files/${up.body.file.file_id}`);
  assert.equal(dl.status, 200);
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), data);
  assert.equal(dl.headers.get('x-theychat-sha256'), up.body.file.sha256);
  assert.equal(dl.headers.get('content-length'), String(data.length));

  const big = await srv.call('POST', '/v1/channels/files/files?name=big.bin', { clientId: CID_A, body: Buffer.alloc(2048) });
  assert.equal(big.status, 413);
  const empty = await srv.call('POST', '/v1/channels/files/files?name=e.bin', { clientId: CID_A, body: Buffer.alloc(0) });
  assert.equal(empty.status, 422);
  assert.equal((await srv.call('GET', '/v1/channels/files/files/f_AAAAAAAAAAAAAAAA', { clientId: CID_A })).status, 404);

  // 跨频道引用同一 file_id → 404
  await srv.call('POST', '/v1/channels', { json: { name: 'other' } });
  assert.equal((await srv.call('GET', `/v1/channels/other/files/${up.body.file.file_id}`)).status, 404);
});

test('channel members: cursor holders only, most recently active first, no X-Client-Id needed', async () => {
  // 频道不存在 → 404 channel_not_found（沿用 requireChannel）
  const nf = await srv.call('GET', '/v1/channels/no-such-ch/members');
  assert.equal(nf.status, 404, nf.text);
  assert.equal(nf.body.error.code, 'channel_not_found');

  // 两个 client_id 各 recv 一次（首拉初始化游标，§5）→ 各成为频道成员；间隔保证 updated_at 有先后
  await srv.call('POST', '/v1/channels', { json: { name: 'members' } });
  await srv.call('GET', '/v1/channels/members/messages', { clientId: CID_A });
  await new Promise((r) => setTimeout(r, 30));
  await srv.call('GET', '/v1/channels/members/messages', { clientId: CID_B });

  // 无头即可读（成员列表是频道公开信息）
  const r = await srv.call('GET', '/v1/channels/members/members');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.channel, 'members');
  assert.equal(r.body.count, 2);
  assert.deepEqual(r.body.members.map((m) => m.client_id), [CID_B, CID_A]); // 最近活跃在前
  for (const m of r.body.members) {
    assert.equal(typeof m.client_id, 'string');
    assert.equal(typeof m.cursor, 'number');
    assert.equal(typeof m.updated_at, 'number');
  }
  assert.ok(r.body.members[0].updated_at >= r.body.members[1].updated_at);
});
