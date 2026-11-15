import http from 'node:http';
import { createReadStream } from 'node:fs';
import { parseBoundary, parseMultipart, MultipartError } from './multipart.mjs';
import { DeliveryStore, ReceiveError, sha256Hex, deliveryKey } from './store.mjs';

const DEFAULT_LIMITS = {
  maxParts: 256,
  maxHeaderBytes: 32 * 1024,
  maxPreambleBytes: 64 * 1024,
  maxPartBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxManifestBytes: 2 * 1024 * 1024,
  maxDeliveryIdLength: 512,
};

function readDeliveryId(headers) {
  const value = headers['x-delivery-id'];
  if (typeof value !== 'string' || value.trim() === '') return null;
  const id = value.trim();
  if (id.length > DEFAULT_LIMITS.maxDeliveryIdLength || /[\u0000-\u001f\u007f]/.test(id)) return null;
  return id;
}

function json(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(body) + '\n');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  response.end(payload);
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function classOf(error) {
  if (error instanceof MultipartError || error instanceof ReceiveError) return error;
  if (['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'ECONNABORTED'].includes(error?.code)
    || /aborted|premature/i.test(error?.message ?? '')) {
    return new MultipartError('客户端在完成边界前中断', 'incomplete', 422);
  }
  return null;
}

export async function startReceiver(options = {}) {
  if (!options.stateDir) throw new Error('接收服务需要 stateDir');
  const limits = { ...DEFAULT_LIMITS, ...options };
  const store = new DeliveryStore(options.stateDir, limits);
  await store.init();
  const tracked = new Set();
  let inflight = 0;
  let idleWaiters = [];
  const settle = () => {
    inflight -= 1;
    if (inflight === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };

  const server = http.createServer(async (request, response) => {
    request.on('error', () => {});
    response.on('error', () => {});
    tracked.add(request);
    response.once('close', () => tracked.delete(request));
    inflight += 1;
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      await route(url.pathname, request, response);
    } catch {
      json(response, 500, { error: '服务端处理失败', code: 'internal' });
    } finally {
      settle();
    }
  });

  async function route(pathname, request, response) {
    if (pathname === '/deliver') {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST');
        json(response, 405, { error: '只接受 POST', code: 'method-not-allowed' });
        return;
      }
      await deliver(request, response);
      return;
    }

    const receiptMatch = pathname.match(/^\/receipts\/([^/]+)$/);
    if (receiptMatch) {
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET');
        json(response, 405, { error: '只接受 GET', code: 'method-not-allowed' });
        return;
      }
      const deliveryId = decodeSegment(receiptMatch[1]);
      if (deliveryId === null) { json(response, 400, { error: '交付号编码无效', code: 'invalid' }); return; }
      const receipt = await store.getReceipt(deliveryId);
      if (!receipt) {
        json(response, 404, {
          error: '没有已完成的接收收据',
          code: 'receipt-not-found',
          deliveryId,
        });
        return;
      }
      json(response, 200, receipt);
      return;
    }

    const filesMatch = pathname.match(/^\/deliveries\/([^/]+)\/files$/);
    const fileMatch = pathname.match(/^\/deliveries\/([^/]+)\/files\/([^/]+)$/);
    const deliveryMatch = pathname.match(/^\/deliveries\/([^/]+)$/);
    if (filesMatch || fileMatch || deliveryMatch) {
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('allow', 'GET, HEAD');
        json(response, 405, { error: '只接受 GET', code: 'method-not-allowed' });
        return;
      }
      if (deliveryMatch) {
        const deliveryId = decodeSegment(deliveryMatch[1]);
        const receipt = deliveryId === null ? null : await store.getReceipt(deliveryId);
        if (!receipt) { json(response, 404, { error: '没有已接收的交付组', code: 'not-found' }); return; }
        if (request.method === 'HEAD') { response.writeHead(200).end(); return; }
        json(response, 200, receipt);
        return;
      }
      if (filesMatch) {
        const deliveryId = decodeSegment(filesMatch[1]);
        const listing = deliveryId === null ? null : await store.listFiles(deliveryId);
        if (!listing) { json(response, 404, { error: '没有已接收的交付组', code: 'not-found' }); return; }
        if (request.method === 'HEAD') { response.writeHead(200).end(); return; }
        json(response, 200, listing);
        return;
      }
      const deliveryId = decodeSegment(fileMatch[1]);
      const contentId = decodeSegment(fileMatch[2]);
      const found = deliveryId === null || contentId === null
        ? null
        : await store.openCommittedFile(deliveryId, contentId);
      if (!found) { json(response, 404, { error: '交付组中没有该文件', code: 'not-found' }); return; }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': found.file.bytes,
        'cache-control': 'no-store',
        'x-content-sha256': found.file.sha256,
        etag: '"' + found.file.sha256 + '"',
      });
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = createReadStream(found.path);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
      return;
    }

    json(response, 404, { error: '无此资源', code: 'not-found' });
  }

  async function deliver(request, response) {
    let handle = null;
    try {
      const deliveryId = readDeliveryId(request.headers);
      if (!deliveryId) {
        request.resume();
        await store.recordAttempt({ deliveryId: null, outcome: 'rejected', code: 'missing-delivery-id', status: 422 });
        json(response, 422, {
          error: '缺少可用的 x-delivery-id',
          code: 'missing-delivery-id',
          accepted: false,
        });
        return;
      }
      const contentType = request.headers['content-type'];
      if (typeof contentType !== 'string' || !/^multipart\//i.test(contentType)) {
        request.resume();
        await store.recordAttempt({ deliveryId, outcome: 'rejected', code: 'unsupported-media-type', status: 415 });
        json(response, 415, { error: '需要 multipart/related 请求', code: 'unsupported-media-type', accepted: false });
        return;
      }
      const boundary = parseBoundary(contentType);
      if (!boundary) {
        request.resume();
        await store.recordAttempt({ deliveryId, outcome: 'rejected', code: 'invalid-boundary', status: 400 });
        json(response, 400, { error: 'multipart 边界缺失或无效', code: 'invalid-boundary', accepted: false });
        return;
      }
      const declared = request.headers['content-length'];
      if (declared !== undefined && Number(declared) > limits.maxTotalBytes) {
        request.resume();
        await store.recordAttempt({ deliveryId, outcome: 'rejected', code: 'too-large', status: 413 });
        json(response, 413, { error: '请求体超出接收上限', code: 'too-large', accepted: false });
        return;
      }

      handle = await store.beginDelivery(deliveryId, contentType);
      await store.recordAttempt({
        attemptId: handle.attemptId,
        deliveryId,
        outcome: 'started',
        parts: 0,
        receivedBytes: 0,
      });

      await parseMultipart(request, {
        boundary,
        maxParts: limits.maxParts,
        maxHeaderBytes: limits.maxHeaderBytes,
        maxPreambleBytes: limits.maxPreambleBytes,
        maxPartBytes: limits.maxPartBytes,
        maxTotalBytes: limits.maxTotalBytes,
        onPartStart: headers => store.partStart(handle, headers),
        onPartData: chunk => store.partData(handle, chunk),
        onPartEnd: () => store.partEnd(handle),
      });

      const decision = await store.commit(handle);
      if (decision.kind === 'conflict') {
        json(response, 409, {
          error: decision.error,
          code: decision.code,
          accepted: false,
          deliveryId,
          receipt: decision.receipt,
        });
        return;
      }
      json(response, decision.status, {
        ...decision.receipt,
        replayed: decision.kind === 'replayed',
      });
    } catch (error) {
      const classified = classOf(error);
      const status = classified?.status ?? 500;
      const code = classified?.code ?? 'internal';
      const outcome = code === 'incomplete' ? 'incomplete' : 'rejected';
      // `request.destroyed` is also true after a body has been fully consumed,
      // so only the response socket decides whether a reply is still possible.
      const responsePossible = !response.destroyed && !response.writableEnded;
      await store.abort(handle);
      const deliveryId = handle?.deliveryId ?? readDeliveryId(request.headers) ?? null;
      // Record the failure even when the peer is already gone: the audit trail,
      // not the HTTP response, is what proves a truncated upload left no receipt.
      await store.recordAttempt({
        attemptId: handle?.attemptId ?? null,
        deliveryId,
        outcome,
        code,
        status,
        bytes: handle?.receivedBytes ?? 0,
        parts: handle?.parts.size ?? 0,
        clientGone: !responsePossible,
      });
      if (responsePossible) {
        json(response, status, {
          error: classified ? classified.message : '服务端处理失败',
          code,
          accepted: false,
          deliveryId,
          receipt: null,
        });
      } else {
        response.destroy();
      }
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });

  return {
    url: 'http://127.0.0.1:' + server.address().port,
    store,
    async whenIdle() {
      while (inflight > 0) await new Promise(resolve => idleWaiters.push(resolve));
      await store.auditQueue;
    },
    async close() {
      await new Promise(resolve => {
        server.close(() => resolve());
        for (const request of tracked) request.destroy();
        server.closeAllConnections?.();
      });
    },
  };
}

export { sha256Hex, deliveryKey };
