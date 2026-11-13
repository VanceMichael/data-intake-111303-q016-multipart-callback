import http from 'node:http';
import { createHash } from 'node:crypto';

function transfer(target, mode, changed = false) {
  const boundary = 'local-material-boundary';
  const content = Buffer.from(mode === 'boundary-like' ? 'abc\r\n--local-material-boundary-not-a-delimiter\r\n正文' : changed ? '更正内容' : '资料正文');
  const manifest = JSON.stringify({ files: [{ id: 'file-1', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-ID: file-1\r\n\r\n`), content,
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/json\r\nContent-ID: manifest\r\n\r\n${manifest}\r\n--${boundary}--\r\n`),
  ]);
  return new Promise(resolve => {
    const request = http.request(target + '/deliver', { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}`, 'x-delivery-id': 'd1', 'content-length': body.length } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', () => resolve({ interrupted: true }));
    if (mode === 'truncated') { request.write(body.subarray(0, Math.floor(body.length / 2))); setTimeout(() => request.destroy(), 10); return; }
    let offset = 0;
    const pump = () => {
      if (offset === body.length) { request.end(); return; }
      const next = Math.min(body.length, offset + 7);
      request.write(body.subarray(offset, next)); offset = next;
      setImmediate(pump);
    };
    pump();
  });
}

export async function sendMultipart(target, mode) {
  const address = new URL(target);
  if (!['127.0.0.1', 'localhost'].includes(address.hostname)) throw new Error('只能向本地资料接收器投递');
  const attempts = [await transfer(target, mode)];
  if (mode === 'conflict') attempts.push(await transfer(target, mode, true));
  if (mode === 'after-manifest') attempts.push(await transfer(target, mode));
  return { attempts };
}
