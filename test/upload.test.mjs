import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sendMultipart } from '../src/upload-source.mjs';

test('投递源真实分块传输并重复同一交付', async () => {
  const bodies = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    bodies.push({ headers: request.headers, raw: Buffer.concat(chunks).toString() });
    response.end('收到');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await sendMultipart('http://127.0.0.1:' + server.address().port, 'after-manifest');
    assert.equal(result.attempts.length, 2); assert.equal(bodies.length, 2);
    assert.equal(bodies[0].headers['x-delivery-id'], 'd1');
    assert.ok(bodies[0].raw.indexOf('Content-ID: file-1') < bodies[0].raw.indexOf('Content-ID: manifest'));
    assert.equal(bodies[0].raw, bodies[1].raw);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('投递源拒绝向真实远端发送', async () => {
  await assert.rejects(sendMultipart('http://example.com', 'after-manifest'), /只能向本地/);
});
