import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startReceiver } from '../src/callback.mjs';
import { DeliveryStore } from '../src/store.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const BOUNDARY = 'test-boundary-42';

function filePart(contentId, data) {
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Type: application/octet-stream\r\nContent-ID: <${contentId}>\r\n\r\n`),
    data,
    Buffer.from('\r\n'),
  ]);
}

function manifestPart(manifest) {
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Type: application/json\r\nContent-ID: manifest\r\n\r\n`),
    Buffer.from(JSON.stringify(manifest)),
    Buffer.from('\r\n'),
  ]);
}

function manifestFor(entries) {
  return { files: entries.map(([id, data]) => ({ id, bytes: data.length, sha256: sha256(data) })) };
}

function assemble(parts, { close = true } = {}) {
  return Buffer.concat([...parts, Buffer.from(close ? `--${BOUNDARY}--\r\n` : '')]);
}

function post(receiver, body, options = {}) {
  const deliveryId = options.deliveryId ?? 'd1';
  const chunkSize = options.chunkSize ?? (body.length || 1);
  const headers = {
    'content-type': options.contentType ?? `multipart/related; boundary=${BOUNDARY}`,
    'x-delivery-id': deliveryId,
    'content-length': body.length,
    ...options.headers,
  };
  return new Promise(resolve => {
    const request = http.request(receiver.url + (options.path ?? '/deliver'), { method: 'POST', headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        let parsed = null;
        const raw = Buffer.concat(chunks).toString();
        try { parsed = JSON.parse(raw); } catch { /* raw only */ }
        resolve({ status: response.statusCode, raw, body: parsed });
      });
    });
    request.on('error', error => resolve({ error: error.code ?? error.message }));
    if (options.truncateAt !== undefined) {
      request.write(body.subarray(0, options.truncateAt));
      setTimeout(() => request.destroy(), 5);
      return;
    }
    let offset = 0;
    const pump = () => {
      if (offset >= body.length) { request.end(); return; }
      const next = Math.min(body.length, offset + chunkSize);
      request.write(body.subarray(offset, next));
      offset = next;
      setImmediate(pump);
    };
    pump();
  });
}

async function withReceiver(work) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'callback-test-'));
  const receiver = await startReceiver({ stateDir });
  try {
    await work(receiver, stateDir);
  } finally {
    await receiver.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

const FILE_A = Buffer.from('alpha 内容\n');
const FILE_B = Buffer.from('bravo 内容\r\n第二行');

test('part 顺序与文件名不作为身份：清单在后且文件顺序打乱仍完整接收', async () => {
  await withReceiver(async receiver => {
    const body = assemble([
      manifestPart(manifestFor([['file-b', FILE_B], ['file-a', FILE_A]])),
      filePart('file-b', FILE_B),
      filePart('file-a', FILE_A),
    ]);
    for (const chunkSize of [1, 3, 64, body.length]) {
      const deliveryId = 'order-' + chunkSize;
      const response = await post(receiver, body, { deliveryId, chunkSize });
      assert.equal(response.status, 201, 'chunk ' + chunkSize + ': ' + response.raw);
      assert.equal(response.body.replayed, false);
      const receipt = await getJson(receiver.url + '/receipts/' + deliveryId);
      assert.equal(receipt.status, 200);
      assert.deepEqual(receipt.body.files.map(file => file.id), ['file-b', 'file-a']);
      assert.equal(sha256(await readFile(path.join(receiver.store.root, 'groups',
        (await import('../src/store.mjs')).deliveryKey(deliveryId), 'files', sha256(FILE_A)), 'utf8')), sha256(FILE_A));
      const replicated = await fetch(receiver.url + receipt.body.files[0].url);
      assert.equal(sha256(Buffer.from(await replicated.arrayBuffer())), sha256(FILE_B));
    }
  });
});

test('文件内部近似边界按字节保真，包括分块正好切在边界候选上', async () => {
  const tricky = Buffer.from(
    'AAA\r\n--' + BOUNDARY + '-not-delimiter\r\n'
    + 'not-a-delimiter--' + BOUNDARY + '\r\n'
    + '--' + BOUNDARY + '--x\r\n'
    + '--' + BOUNDARY + ' -spaces\r\n'
    + '--' + BOUNDARY + '\t\tpadding-is-not-close\r\n'
    + '--' + BOUNDARY + 'Z\r\n--other-boundary--\r\n'
    + '\r\n--' + BOUNDARY + '-',
  );
  const body = assemble([filePart('tricky', tricky), manifestPart(manifestFor([['tricky', tricky]]))]);
  await withReceiver(async receiver => {
    for (let chunkSize = 1; chunkSize <= 9; chunkSize += 1) {
      const deliveryId = 'tricky-' + chunkSize;
      const response = await post(receiver, body, { deliveryId, chunkSize });
      assert.equal(response.status, 201, 'chunk ' + chunkSize + ': ' + response.raw);
      const url = receiver.url + '/deliveries/' + deliveryId + '/files/tricky';
      const fetched = Buffer.from(await (await fetch(url)).arrayBuffer());
      assert.equal(sha256(fetched), sha256(tricky), 'chunk ' + chunkSize);
    }
  });
});

test('重复 Content-ID、清单缺件、未引用 part、摘要不符都不会产生收据', async () => {
  await withReceiver(async receiver => {
    const duplicate = assemble([
      filePart('file-a', FILE_A),
      filePart('file-a', FILE_A),
      manifestPart(manifestFor([['file-a', FILE_A]])),
    ]);
    const duplicateResult = await post(receiver, duplicate, { deliveryId: 'dup' });
    assert.equal(duplicateResult.status, 422);
    assert.equal(duplicateResult.body.code, 'duplicate-content-id');

    const missing = assemble([filePart('file-a', FILE_A), manifestPart(manifestFor([['file-a', FILE_A], ['file-b', FILE_B]]))]);
    const missingResult = await post(receiver, missing, { deliveryId: 'missing' });
    assert.equal(missingResult.status, 422);
    assert.equal(missingResult.body.code, 'missing-file');

    const extra = assemble([filePart('file-a', FILE_A), filePart('file-b', FILE_B), manifestPart(manifestFor([['file-a', FILE_A]]))]);
    const extraResult = await post(receiver, extra, { deliveryId: 'extra' });
    assert.equal(extraResult.status, 422);
    assert.equal(extraResult.body.code, 'unreferenced-part');

    const wrongSize = { files: [{ id: 'file-a', bytes: FILE_A.length + 1, sha256: sha256(FILE_A) }] };
    const wrongDigest = { files: [{ id: 'file-a', bytes: FILE_A.length, sha256: sha256(Buffer.from('other')) }] };
    for (const [deliveryId, manifest] of [['wrong-size', wrongSize], ['wrong-digest', wrongDigest]]) {
      const result = await post(receiver, assemble([filePart('file-a', FILE_A), manifestPart(manifest)]), { deliveryId });
      assert.equal(result.status, 422);
      assert.equal(result.body.receipt, null);
    }

    for (const deliveryId of ['dup', 'missing', 'extra', 'wrong-size', 'wrong-digest']) {
      assert.equal((await getJson(receiver.url + '/receipts/' + deliveryId)).status, 404);
    }
    assert.deepEqual(await readdir(path.join(receiver.store.stagingDir)), []);
    assert.deepEqual(await readdir(path.join(receiver.store.groupsDir)), []);
  });
});

test('客户端中断在半截：无完成收据，重送后只有一套可见资料', async () => {
  await withReceiver(async receiver => {
    const body = assemble([filePart('file-a', FILE_A), manifestPart(manifestFor([['file-a', FILE_A]]))]);
    const truncated = await post(receiver, body, { deliveryId: 'half', truncateAt: Math.floor(body.length / 2) });
    assert.equal(truncated.body?.accepted ?? false, false);
    await receiver.whenIdle();
    assert.deepEqual(await readdir(path.join(receiver.store.stagingDir)), []);
    assert.deepEqual(await readdir(path.join(receiver.store.groupsDir)), []);
    assert.equal((await getJson(receiver.url + '/receipts/half')).status, 404);
    const attempts = receiver.store.attempts.filter(attempt => attempt.deliveryId === 'half');
    assert.ok(attempts.some(attempt => attempt.outcome === 'incomplete'));
    assert.ok(!attempts.some(attempt => attempt.outcome === 'received' || attempt.outcome === 'replayed'));

    const resent = await post(receiver, body, { deliveryId: 'half', chunkSize: 5 });
    assert.equal(resent.status, 201);
    await receiver.whenIdle();
    assert.equal((await getJson(receiver.url + '/receipts/half')).status, 200);
    const files = await readdir(path.join(receiver.store.groupsDir));
    assert.equal(files.length, 1);
    assert.deepEqual(await readdir(path.join(receiver.store.stagingDir)), []);
  });
});

test('关闭边界前的尾部残缺与缺少关闭边界都判为不完整', async () => {
  await withReceiver(async receiver => {
    const whole = assemble([filePart('file-a', FILE_A), manifestPart(manifestFor([['file-a', FILE_A]]))]);
    const withoutClose = assemble([filePart('file-a', FILE_A), manifestPart(manifestFor([['file-a', FILE_A]]))], { close: false });
    const cutInsideClose = whole.subarray(0, whole.length - 4);
    for (const [deliveryId, body] of [['no-close', withoutClose], ['cut-close', cutInsideClose]]) {
      const result = await post(receiver, body, { deliveryId });
      assert.equal(result.body?.accepted ?? false, false, deliveryId);
      assert.equal((await getJson(receiver.url + '/receipts/' + deliveryId)).status, 404, deliveryId);
    }
    assert.deepEqual(await readdir(path.join(receiver.store.groupsDir)), []);
  });
});

test('整组一致重送复用原收据，内容变化为冲突且不覆盖已接收文件', async () => {
  await withReceiver(async receiver => {
    const first = assemble([filePart('file-a', FILE_A), manifestPart(manifestFor([['file-a', FILE_A]]))]);
    const created = await post(receiver, first, { deliveryId: 'same', chunkSize: 2 });
    assert.equal(created.status, 201);
    const accepted = await getJson(receiver.url + '/receipts/same');
    const acceptedBytes = await readFile(path.join(receiver.store.groupsDir,
      (await import('../src/store.mjs')).deliveryKey('same'), 'files', sha256(FILE_A)));

    const replay = await post(receiver, first, { deliveryId: 'same', chunkSize: 1 });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.receivedAt, accepted.body.receivedAt);
    assert.equal(replay.body.groupDigest, accepted.body.groupDigest);

    const changedFile = Buffer.from('charlie 被替换的内容');
    const changed = assemble([filePart('file-a', changedFile), manifestPart(manifestFor([['file-a', changedFile]]))]);
    const conflict = await post(receiver, changed, { deliveryId: 'same' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'delivery-conflict');
    assert.equal(conflict.body.receipt.id, 'same');

    const after = await getJson(receiver.url + '/receipts/same');
    assert.equal(after.body.receivedAt, accepted.body.receivedAt);
    assert.equal(after.body.groupDigest, accepted.body.groupDigest);
    const fileOnDisk = await readFile(path.join(receiver.store.groupsDir,
      (await import('../src/store.mjs')).deliveryKey('same'), 'files', sha256(FILE_A)));
    assert.deepEqual(fileOnDisk, acceptedBytes);
    assert.deepEqual(await readdir(path.join(receiver.store.stagingDir)), []);
  });
});

test('进程重启清理未完成暂存但不删除已接收组', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'callback-restart-'));
  try {
    const first = await startReceiver({ stateDir });
    const body = assemble([filePart('file-a', FILE_A), manifestPart(manifestFor([['file-a', FILE_A]]))]);
    assert.equal((await post(first, body, { deliveryId: 'kept' })).status, 201);
    await first.whenIdle();
    await first.close();

    // Simulate a crash: a staging directory and a group directory without a receipt.
    const staging = new DeliveryStore(stateDir);
    await staging.init();
    const leftoverAttempt = path.join(staging.stagingDir, 'crashed');
    const orphanGroup = path.join(staging.groupsDir, 'orphan');
    await mkdir(path.join(leftoverAttempt, 'parts'), { recursive: true });
    await writeFile(path.join(leftoverAttempt, 'parts', '001.part'), '半截');
    await mkdir(orphanGroup, { recursive: true });
    await writeFile(path.join(orphanGroup, 'manifest.raw'), '{}');

    const second = await startReceiver({ stateDir });
    try {
      assert.deepEqual(await readdir(second.store.stagingDir), []);
      assert.ok(!(await readdir(second.store.groupsDir)).includes('orphan'));
      const receipt = await getJson(second.url + '/receipts/kept');
      assert.equal(receipt.status, 200);
      const fetched = await fetch(second.url + receipt.body.files[0].url);
      assert.equal(sha256(Buffer.from(await fetched.arrayBuffer())), sha256(FILE_A));
      const replay = await post(second, body, { deliveryId: 'kept' });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.groupDigest, receipt.body.groupDigest);
    } finally {
      await second.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('并发同号重送只有一个落盘组，另一个得到复用收据', async () => {
  await withReceiver(async receiver => {
    const body = assemble([filePart('file-a', FILE_A), manifestPart(manifestFor([['file-a', FILE_A]]))]);
    const results = await Promise.all([0, 1, 2, 3].map(() => post(receiver, body, { deliveryId: 'race' })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 200, 200, 201]);
    const groups = await readdir(path.join(receiver.store.groupsDir));
    assert.equal(groups.length, 1);
  });
});

test('HTTP 方法与入口约束：缺少交付号或边界时直接拒绝且不留组', async () => {
  await withReceiver(async receiver => {
    const body = assemble([filePart('file-a', FILE_A)]);
    const noId = await post(receiver, body, { deliveryId: '', headers: { 'x-delivery-id': '' } });
    assert.equal(noId.status, 422);
    assert.equal(noId.body.code, 'missing-delivery-id');
    const noBoundary = await post(receiver, body, { deliveryId: 'nb', contentType: 'multipart/related' });
    assert.equal(noBoundary.status, 400);
    const missing = await fetch(receiver.url + '/receipts/never-delivered');
    assert.equal(missing.status, 404);
    assert.deepEqual(await readdir(path.join(receiver.store.groupsDir)), []);
  });
});

test('支持大文件在任意小分块下流式落盘', async () => {
  await withReceiver(async receiver => {
    const big = randomBytes(2 * 1024 * 1024);
    const body = assemble([filePart('big', big), manifestPart(manifestFor([['big', big]]))]);
    const result = await post(receiver, body, { deliveryId: 'big', chunkSize: 4096 });
    assert.equal(result.status, 201, result.raw);
    const fetched = Buffer.from(await (await fetch(receiver.url + '/deliveries/big/files/big')).arrayBuffer());
    assert.equal(sha256(fetched), sha256(big));
  });
});
