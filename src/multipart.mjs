import { Buffer } from 'node:buffer';

const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');

export class MultipartError extends Error {
  constructor(message, code = 'invalid', status = 400) {
    super(message);
    this.name = 'MultipartError';
    this.code = code;
    this.status = status;
  }
}

export function parseBoundary(contentType) {
  if (typeof contentType !== 'string') return null;
  const match = /(?:^|;)\s*boundary\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(contentType);
  const value = match ? (match[1] ?? match[2]) : '';
  if (!value || value.length > 200 || /[\r\n]/.test(value)) return null;
  return value;
}

function parseHeaders(raw) {
  const headers = Object.create(null);
  let previous = null;
  for (const line of raw.split('\r\n')) {
    if (line === '') continue;
    if ((line.startsWith(' ') || line.startsWith('\t')) && previous) {
      headers[previous][headers[previous].length - 1] += ' ' + line.trim();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) throw new MultipartError('part 头格式无效', 'invalid', 400);
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    previous = name;
    (headers[name] ??= []).push(value);
  }
  return headers;
}

export function normalizeContentId(value) {
  if (typeof value !== 'string') return null;
  let id = value.trim();
  if (id.startsWith('<') && id.endsWith('>')) id = id.slice(1, -1).trim();
  return id || null;
}

export function classifyDelimiterSuffix(buffer, position, eof) {
  if (position >= buffer.length) {
    return eof ? { type: 'invalid' } : { type: 'need-more' };
  }
  if (buffer[position] === 0x2d) {
    if (position + 1 >= buffer.length) return eof ? { type: 'invalid' } : { type: 'need-more' };
    if (buffer[position + 1] !== 0x2d) return { type: 'invalid' };
    // A close delimiter must be followed only by transport padding and CRLF
    // (or the end of the body). `--boundary--x` inside file content is data.
    let close = position + 2;
    while (close < buffer.length && (buffer[close] === 0x20 || buffer[close] === 0x09)) close += 1;
    if (close >= buffer.length) return eof ? { type: 'close', consume: close - position } : { type: 'need-more' };
    if (buffer[close] === 0x0d) {
      if (close + 1 >= buffer.length) return eof ? { type: 'invalid' } : { type: 'need-more' };
      if (buffer[close + 1] === 0x0a) return { type: 'close', consume: close + 2 - position };
    }
    return { type: 'invalid' };
  }
  let index = position;
  while (index < buffer.length && (buffer[index] === 0x20 || buffer[index] === 0x09)) index += 1;
  if (index >= buffer.length) return eof ? { type: 'invalid' } : { type: 'need-more' };
  if (buffer[index] === 0x0d) {
    if (index + 1 >= buffer.length) return eof ? { type: 'invalid' } : { type: 'need-more' };
    if (buffer[index + 1] === 0x0a) return { type: 'open', consume: index + 2 - position };
  }
  return { type: 'invalid' };
}

/**
 * Incrementally parse a multipart/related request body.
 *
 * The parser never buffers the whole request: data before a possible boundary is
 * handed to onPartData as soon as it is known not to be part of a delimiter.
 * A delimiter inside file content is only recognised when the bytes following
 * the boundary are exactly `--` or optional padding plus CRLF, so a string such
 * as `--boundary-not-a-delimiter` remains ordinary file content.
 */
export async function parseMultipart(request, options) {
  const {
    boundary,
    maxParts = 256,
    maxHeaderBytes = 32 * 1024,
    maxPreambleBytes = 64 * 1024,
    maxPartBytes = 32 * 1024 * 1024,
    maxTotalBytes = 256 * 1024 * 1024,
    onPartStart,
    onPartData,
    onPartEnd,
  } = options;

  const boundaryMarker = Buffer.from('--' + boundary);
  const bodyMarker = Buffer.concat([CRLF, boundaryMarker]);
  let buffer = Buffer.alloc(0);
  let state = 'preamble';
  let partCount = 0;
  let partBytes = 0;
  let totalBytes = 0;
  let completed = false;

  async function emit(chunk) {
    if (!chunk || chunk.length === 0) return;
    totalBytes += chunk.length;
    partBytes += chunk.length;
    if (totalBytes > maxTotalBytes) {
      throw new MultipartError('请求体超出接收上限', 'too-large', 413);
    }
    if (partBytes > maxPartBytes) {
      throw new MultipartError('单个 part 超出接收上限', 'too-large', 413);
    }
    await onPartData(chunk);
  }

  async function pump(eof) {
    for (;;) {
      if (state === 'preamble') {
        let searchFrom = 0;
        let found = -1;
        for (;;) {
          const position = buffer.indexOf(boundaryMarker, searchFrom);
          if (position === -1) break;
          if (position === 0 || (position >= 2 && buffer[position - 2] === 0x0d && buffer[position - 1] === 0x0a)) {
            found = position;
            break;
          }
          searchFrom = position + 1;
        }
        if (found === -1) {
          if (eof) throw new MultipartError('请求体不包含 multipart 边界', 'invalid', 400);
          if (buffer.length > maxPreambleBytes) throw new MultipartError('multipart 前导内容过大', 'invalid', 400);
          return;
        }
        const suffix = classifyDelimiterSuffix(buffer, found + boundaryMarker.length, eof);
        if (suffix.type === 'need-more') return;
        if (suffix.type === 'invalid') {
          buffer = buffer.subarray(found + 1);
          continue;
        }
        const after = found + boundaryMarker.length + suffix.consume;
        buffer = buffer.subarray(after);
        if (suffix.type === 'close') {
          state = 'epilogue';
        } else {
          state = 'headers';
        }
        continue;
      }

      if (state === 'headers') {
        const end = buffer.indexOf(HEADER_END);
        if (end === -1) {
          if (eof) throw new MultipartError('part 头未结束', 'incomplete', 422);
          if (buffer.length > maxHeaderBytes) throw new MultipartError('part 头超出上限', 'invalid', 400);
          return;
        }
        const rawHeaders = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + HEADER_END.length);
        partCount += 1;
        if (partCount > maxParts) throw new MultipartError('part 数量超出上限', 'too-large', 413);
        partBytes = 0;
        const headers = parseHeaders(rawHeaders);
        await onPartStart(headers, partCount);
        state = 'body';
        continue;
      }

      if (state === 'body') {
        let position = -1;
        let found = null;
        let searchFrom = 0;
        while (buffer.length >= bodyMarker.length) {
          const candidate = buffer.indexOf(bodyMarker, searchFrom);
          if (candidate === -1) break;
          const suffix = classifyDelimiterSuffix(buffer, candidate + bodyMarker.length, eof);
          if (suffix.type === 'need-more') {
            // Keep the candidate and anything after it; flush the rest early.
            if (candidate > 0) {
              const flush = buffer.subarray(0, candidate);
              buffer = buffer.subarray(candidate);
              await emit(flush);
            }
            return;
          }
          if (suffix.type === 'invalid') {
            searchFrom = candidate + 1;
            continue;
          }
          position = candidate;
          found = suffix;
          break;
        }
        if (position === -1) {
          if (eof) throw new MultipartError('请求在 part 结束前中断', 'incomplete', 422);
          const keep = bodyMarker.length + 8;
          if (buffer.length > keep) {
            const flush = buffer.subarray(0, buffer.length - keep);
            buffer = buffer.subarray(buffer.length - keep);
            await emit(flush);
          }
          return;
        }
        const suffix = found;
        const flush = position > 0 ? buffer.subarray(0, position) : null;
        const next = position + bodyMarker.length + suffix.consume;
        buffer = buffer.subarray(next);
        if (flush) await emit(flush);
        await onPartEnd(partCount);
        if (suffix.type === 'close') {
          state = 'epilogue';
          completed = true;
          buffer = Buffer.alloc(0);
          return;
        }
        state = 'headers';
        continue;
      }

      // Epilogue is ignored, including any final CRLF after the close delimiter.
      buffer = Buffer.alloc(0);
      if (eof) return;
      break;
    }
  }

  let failure = null;
  for await (const chunk of request) {
    if (failure) {
      // Keep consuming so the server can still send its rejection response;
      // the request is only abandoned if the sender never stops.
      continue;
    }
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);    try {
      await pump(false);
    } catch (error) {
      failure = error;
      buffer = Buffer.alloc(0);
    }
  }
  if (failure) throw failure;
  await pump(true);
  if (!completed) throw new MultipartError('请求在完成边界前结束', 'incomplete', 422);
}
