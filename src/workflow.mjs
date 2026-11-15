import { mkdir, open, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startReceiver } from './callback.mjs';
import { sha256Hex } from './store.mjs';

async function writeJsonAtomic(file, value) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.tmp-result-${randomBytes(6).toString('hex')}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), ...options });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: response.status, body, raw };
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const data = Buffer.from(await response.arrayBuffer());
  return { status: response.status, data };
}

/**
 * Receive one supplier callback delivery group.
 *
 * Ordering is what makes a receipt trustworthy:
 *   1. parts stream to a private staging directory (never visible as a group);
 *   2. after the close delimiter the manifest is checked against the bytes and
 *      digests of every file part, and the group is assembled in a temp dir;
 *   3. the temp dir is renamed into groups/<key>, then receipt.json is written;
 *   4. only after that does the HTTP response report success.
 * A truncated upload therefore cannot leave a receipt, and a resend with the
 * same group digest reuses the first receipt instead of creating a second copy.
 */
export async function run({ source, stateDir, input = {} } = {}) {
  if (!source) throw new Error('缺少来源地址');
  if (!stateDir) throw new Error('缺少状态目录');
  await mkdir(stateDir, { recursive: true });

  const receiver = await startReceiver({ stateDir });
  let sendResponse = null;
  let sendError = null;
  const receiptQueries = [];
  const fileChecks = [];

  try {
    try {
      sendResponse = await requestJson(source.replace(/\/+$/, '') + '/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: receiver.url, transfer: input.transfer }),
      });
    } catch (error) {
      sendError = error.message;
    }

    // The supplier may close the /send connection before our side observes the
    // end of the callback body; wait for every in-flight request to finish.
    await receiver.whenIdle();
    // A request that was reset mid-body is only observed after state cleanup;
    // give that teardown a turn so the report includes its final outcome.
    await new Promise(resolve => setImmediate(resolve));
    await receiver.whenIdle();

    const report = await receiver.store.report();
    const deliveryIds = [...new Set(report.attempts.map(attempt => attempt.deliveryId).filter(Boolean))];
    const received = [];
    const conflicts = [];
    const incomplete = [];
    const deliveries = [];

    for (const id of deliveryIds) {
      const attempts = report.attempts.filter(attempt => attempt.deliveryId === id);
      const query = await requestJson(receiver.url + '/receipts/' + encodeURIComponent(id));
      receiptQueries.push({ path: '/receipts/' + encodeURIComponent(id), status: query.status, body: query.raw });

      const accepted = attempts.some(attempt => attempt.outcome === 'received' || attempt.outcome === 'replayed');
      const conflicted = attempts.some(attempt => attempt.outcome === 'conflict');
      const failed = attempts.some(attempt => attempt.outcome === 'incomplete' || attempt.outcome === 'rejected');
      const receipt = query.status === 200 ? query.body : null;

      if (receipt) {
        if (!received.includes(id)) received.push(id);
        for (const file of receipt.files) {
          const fetched = await download(receiver.url + file.url);
          const actualSha256 = sha256Hex(fetched.data);
          fileChecks.push({
            deliveryId: id,
            contentId: file.contentId,
            status: fetched.status,
            declaredBytes: file.bytes,
            actualBytes: fetched.data.length,
            declaredSha256: file.sha256,
            actualSha256,
            matches: fetched.status === 200
              && fetched.data.length === file.bytes
              && actualSha256 === file.sha256,
          });
        }
      } else if (failed) {
        incomplete.push(id);
      }
      if (conflicted && !conflicts.includes(id)) conflicts.push(id);
      if (!receipt && !failed && !conflicted && !incomplete.includes(id)) incomplete.push(id);

      deliveries.push({
        id,
        receipt: receipt ? {
          status: receipt.status,
          receivedAt: receipt.receivedAt,
          groupDigest: receipt.groupDigest,
          files: receipt.files.map(file => ({
            contentId: file.contentId,
            bytes: file.bytes,
            sha256: file.sha256,
          })),
        } : null,
        attempts: attempts.map(attempt => ({
          outcome: attempt.outcome,
          status: attempt.status ?? null,
          code: attempt.code ?? null,
          parts: attempt.parts ?? 0,
          receivedBytes: attempt.receivedBytes ?? attempt.bytes ?? 0,
          receiptId: attempt.receiptId ?? null,
          groupDigest: attempt.groupDigest ?? null,
          clientGone: attempt.clientGone ?? false,
        })),
      });
    }

    const result = {
      received,
      conflicts,
      incomplete,
      deliveries,
      evidence: {
        receiver: receiver.url,
        receiptQueries,
        files: fileChecks,
        stagingEmpty: (await receiver.store.stagingContents()).length === 0,
        sourceSend: sendResponse
          ? { status: sendResponse.status, body: sendResponse.body }
          : { error: sendError },
      },
    };
    await writeJsonAtomic(path.join(stateDir, 'result.json'), result);
    return result;
  } finally {
    await receiver.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.SOURCE) throw new Error('设置 SOURCE 指向本地来源');
  const input = process.argv[2] ? JSON.parse(process.argv[2]) : { transfer: process.env.TRANSFER ?? 'after-manifest' };
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const stateDir = await mkdtemp(path.join(tmpdir(), 'material-run-'));
  try {
    console.log(JSON.stringify(await run({ source: process.env.SOURCE, stateDir, input }), null, 2));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}
