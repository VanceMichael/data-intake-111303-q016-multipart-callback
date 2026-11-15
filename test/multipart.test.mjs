import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBoundary, parseMultipart, MultipartError } from '../src/multipart.mjs';

const encoder = new TextEncoder();

async function drain(chunks, options) {
  async function* source() { for (const chunk of chunks) yield Buffer.from(chunk); }
  return new Promise((resolve, reject) => {
    const parts = [];
    let current = null;
    parseMultipart(source(), {
      maxParts: 8,
      maxHeaderBytes: 1024,
      maxPreambleBytes: 1024,
      maxPartBytes: 4096,
      maxTotalBytes: 8192,
      ...options,
      onPartStart(headers) {
        current = { headers, chunks: [] };
        parts.push(current);
      },
      onPartData(chunk) {
        current.chunks.push(Buffer.from(chunk));
      },
      onPartEnd() {
        current = null;
      },
    }).then(() => resolve(parts.map(part => ({
      contentType: part.headers['content-type']?.[0],
      body: Buffer.concat(part.chunks).toString('utf8'),
    }))), reject);
  });
}

test('边界参数支持引号与大小写，缺失或含换行时拒绝', () => {
  assert.equal(parseBoundary('multipart/related; boundary="a b"'), 'a b');
  assert.equal(parseBoundary('Multipart/Related; BOUNDARY=xyz; type="text/plain"'), 'xyz');
  assert.equal(parseBoundary('multipart/related'), null);
  assert.equal(parseBoundary('multipart/related; boundary='), null);
  assert.equal(parseBoundary('multipart/related; boundary="a\r\nb"'), null);
  assert.equal(parseBoundary(undefined), null);
});

test('逐字节输入仍能还原 part 内容', async () => {
  const body = 'preamble\r\n--cut\r\nContent-Type: text/plain\r\n\r\nhello\r\nworld\r\n--cut--\r\n';
  const bytes = [...encoder.encode(body)].map(byte => Uint8Array.of(byte));
  const parts = await drain(bytes, { boundary: 'cut' });
  assert.deepEqual(parts, [{ contentType: 'text/plain', body: 'hello\r\nworld' }]);
});

test('文件内容里的半截边界与近似边界不会被当成结束', async () => {
  const content = 'a\r\n--cut-not\r\nb\r\n--cut--x\r\nc\r\n--cut  x\r\nd\r\n--cu';
  const body = `--cut\r\nContent-ID: f\r\n\r\n${content}\r\n--cut--`;
  const parts = await drain([body], { boundary: 'cut' });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].body, content);
});

test('最后一个 part 允许没有结尾 CRLF，关闭边界后允许 transport padding', async () => {
  const parts = await drain(['--cut\r\nContent-ID: f\r\n\r\ntail\r\n--cut--  '], { boundary: 'cut' });
  assert.equal(parts[0].body, 'tail');
});

test('缺少关闭边界、part 头未结束与超限分别报错', async () => {
  await assert.rejects(drain(['--cut\r\nContent-ID: f\r\n\r\nbody'], { boundary: 'cut' }),
    error => error instanceof MultipartError && error.code === 'incomplete' && error.status === 422);
  await assert.rejects(drain(['--cut\r\nContent-ID: f'], { boundary: 'cut' }),
    error => error instanceof MultipartError && error.code === 'incomplete');
  await assert.rejects(drain(['--nope\r\n'], { boundary: 'cut' }),
    error => error instanceof MultipartError && error.code === 'invalid');
  await assert.rejects(drain(['--cut\r\nContent-ID: f\r\n\r\n0123456789\r\n--cut--'], { boundary: 'cut', maxPartBytes: 4 }),
    error => error instanceof MultipartError && error.code === 'too-large' && error.status === 413);
  await assert.rejects(drain(['--cut\r\nContent-ID: a\r\n\r\nx\r\n--cut\r\nContent-ID: b\r\n\r\ny\r\n--cut--'],
    { boundary: 'cut', maxParts: 1 }),
  error => error instanceof MultipartError && error.code === 'too-large');
});

test('先失败后仍然读完请求，错误在流结束后抛出', async () => {
  let consumed = 0;
  async function* source() {
    yield Buffer.from('--cut\r\nContent-ID: a\r\n\r\nxxxxxxxx\r\n--cut--\r\n');
    for (let index = 0; index < 5; index += 1) {
      consumed += 1;
      yield Buffer.from('--ignore--\r\n');
    }
  }
  await assert.rejects(parseMultipart(source(), {
    boundary: 'cut',
    maxPartBytes: 4,
    maxTotalBytes: 100000,
    onPartStart() {},
    onPartData() {},
    onPartEnd() {},
  }), error => error.code === 'too-large');
  assert.equal(consumed, 5);
});
