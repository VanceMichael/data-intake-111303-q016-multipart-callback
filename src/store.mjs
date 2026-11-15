import { createHash, randomBytes } from 'node:crypto';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

const HEX64 = /^[0-9a-f]{64}$/;

export class ReceiveError extends Error {
  constructor(message, code = 'invalid', status = 422) {
    super(message);
    this.name = 'ReceiveError';
    this.code = code;
    this.status = status;
  }
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function deliveryKey(deliveryId) {
  return sha256Hex(Buffer.from(String(deliveryId), 'utf8'));
}

export function canonicalGroup(entries) {
  const files = entries
    .map(entry => ({ contentId: entry.contentId, id: entry.id, bytes: entry.bytes, sha256: entry.sha256 }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return JSON.stringify({ files });
}

async function fsyncDir(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // Some platforms do not allow fsync on a directory; rename ordering still holds.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWrite(file, data) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(data);
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
  await fsyncDir(directory);
}

async function atomicWriteJson(file, value) {
  await atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function safeUrlPart(value) {
  return encodeURIComponent(value);
}

function validateManifest(raw) {
  let document;
  try {
    document = JSON.parse(raw.toString('utf8').replace(/^﻿/, ''));
  } catch {
    throw new ReceiveError('清单不是有效 JSON', 'invalid-manifest', 422);
  }
  if (!document || typeof document !== 'object' || !Array.isArray(document.files)) {
    throw new ReceiveError('清单缺少 files 数组', 'invalid-manifest', 422);
  }
  const seen = new Set();
  const files = document.files.map((entry, position) => {
    if (!entry || typeof entry !== 'object') {
      throw new ReceiveError(`清单第 ${position} 项不是对象`, 'invalid-manifest', 422);
    }
    if (typeof entry.id !== 'string' || entry.id === '') {
      throw new ReceiveError(`清单第 ${position} 项缺少 id`, 'invalid-manifest', 422);
    }
    if (entry.id === 'manifest') {
      throw new ReceiveError('manifest 是保留的 Content-ID', 'invalid-manifest', 422);
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new ReceiveError(`清单 ${entry.id} 的字节数无效`, 'invalid-manifest', 422);
    }
    if (typeof entry.sha256 !== 'string' || !HEX64.test(entry.sha256.toLowerCase())) {
      throw new ReceiveError(`清单 ${entry.id} 的摘要无效`, 'invalid-manifest', 422);
    }
    if (seen.has(entry.id)) {
      throw new ReceiveError(`清单重复引用 ${entry.id}`, 'duplicate-file', 422);
    }
    seen.add(entry.id);
    return { id: entry.id, bytes: entry.bytes, sha256: entry.sha256.toLowerCase() };
  });
  return files;
}

export class DeliveryStore {
  constructor(stateDir, options = {}) {
    this.root = path.resolve(stateDir);
    this.groupsDir = path.join(this.root, 'groups');
    this.stagingDir = path.join(this.root, 'staged');
    this.deliveriesDir = path.join(this.root, 'deliveries');
    this.auditFile = path.join(this.root, 'attempts.jsonl');
    this.limits = {
      maxParts: options.maxParts ?? 256,
      maxManifestBytes: options.maxManifestBytes ?? 2 * 1024 * 1024,
      maxPartBytes: options.maxPartBytes ?? 32 * 1024 * 1024,
      maxTotalBytes: options.maxTotalBytes ?? 128 * 1024 * 1024,
      maxFiles: options.maxFiles ?? 256,
    };
    this.attempts = [];
    this.locks = new Map();
    this.auditQueue = Promise.resolve();
  }

  async init() {
    await Promise.all([
      mkdir(this.groupsDir, { recursive: true }),
      mkdir(this.stagingDir, { recursive: true }),
      mkdir(this.deliveriesDir, { recursive: true }),
    ]);
    // Unfinished transfers are never receipts; removing them on restart cannot
    // touch an accepted group, which is always addressed by its receipt file.
    for (const entry of await readdir(this.stagingDir)) {
      await rm(path.join(this.stagingDir, entry), { recursive: true, force: true });
    }
    for (const entry of await readdir(this.groupsDir)) {
      const target = path.join(this.groupsDir, entry);
      if (entry.startsWith('.tmp-')) {
        await rm(target, { recursive: true, force: true });
        continue;
      }
      const receiptFile = path.join(target, 'receipt.json');
      if (!(await pathExists(receiptFile))) {
        // A group without a receipt was never acknowledged to the supplier.
        await rm(target, { recursive: true, force: true });
        const staleMapping = path.join(this.deliveriesDir, entry + '.json');
        if (await pathExists(staleMapping)) await rm(staleMapping, { force: true });
        continue;
      }
      await this.repairMapping(entry);
    }
  }

  async repairMapping(key) {
    const mappingFile = path.join(this.deliveriesDir, key + '.json');
    if (await pathExists(mappingFile)) return;
    let receipt;
    try {
      receipt = await readJson(path.join(this.groupsDir, key, 'receipt.json'));
    } catch {
      // Keep unreadable accepted groups instead of deleting evidence.
      return;
    }
    if (!receipt || typeof receipt.deliveryId !== 'string' || typeof receipt.groupDigest !== 'string') return;
    await atomicWriteJson(mappingFile, {
      deliveryId: receipt.deliveryId,
      groupDigest: receipt.groupDigest,
      receiptId: receipt.id,
      committedAt: receipt.receivedAt,
    });
  }

  async withLock(key, work) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const current = previous.then(work, work);
    this.locks.set(key, current.catch(() => {}));
    return current;
  }

  recordAttempt(entry) {
    const record = { at: new Date().toISOString(), ...entry };
    this.attempts.push(record);
    const line = JSON.stringify(record) + '\n';
    this.auditQueue = this.auditQueue
      .then(() => appendFile(this.auditFile, line, { mode: 0o600 }))
      .catch(() => {});
    return this.auditQueue;
  }

  async beginDelivery(deliveryId, contentType) {
    const attemptId = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
    const attemptDir = path.join(this.stagingDir, attemptId);
    await mkdir(path.join(attemptDir, 'parts'), { recursive: true });
    await atomicWriteJson(path.join(attemptDir, 'meta.json'), {
      deliveryId,
      attemptId,
      contentType,
      startedAt: new Date().toISOString(),
    });
    return {
      deliveryId,
      attemptId,
      attemptDir,
      parts: new Map(),
      partIndex: 0,
      receivedBytes: 0,
      current: null,
    };
  }

  async partStart(handle, headers) {
    const ids = headers['content-id'] ?? [];
    if (ids.length !== 1) {
      throw new ReceiveError('每个 part 必须恰好有一个 Content-ID', 'invalid-content-id', 422);
    }
    let contentId = ids[0].trim();
    if (contentId.startsWith('<') && contentId.endsWith('>')) contentId = contentId.slice(1, -1).trim();
    if (!contentId) throw new ReceiveError('Content-ID 为空', 'invalid-content-id', 422);
    if (handle.parts.has(contentId) || (contentId === 'manifest' && handle.manifestSeen)) {
      throw new ReceiveError(`重复 Content-ID：${contentId}`, 'duplicate-content-id', 422);
    }
    if (handle.parts.size >= this.limits.maxFiles + 1) {
      throw new ReceiveError('part 数量超出上限', 'too-large', 413);
    }
    handle.partIndex += 1;
    const file = path.join(handle.attemptDir, 'parts', String(handle.partIndex).padStart(3, '0') + '.part');
    const fileHandle = await open(file, 'wx', 0o600);
    const part = {
      contentId,
      index: handle.partIndex,
      file,
      handle: fileHandle,
      bytes: 0,
      hash: createHash('sha256'),
      headers,
    };
    if (contentId === 'manifest') handle.manifestSeen = true;
    handle.parts.set(contentId, part);
    handle.current = part;
  }

  async partData(handle, chunk) {
    const part = handle.current;
    if (!part) throw new ReceiveError('part 数据出现在开始之前', 'invalid', 422);
    part.bytes += chunk.length;
    handle.receivedBytes += chunk.length;
    if (part.contentId === 'manifest' && part.bytes > this.limits.maxManifestBytes) {
      throw new ReceiveError('清单超出接收上限', 'too-large', 413);
    }
    part.hash.update(chunk);
    await part.handle.write(chunk);
  }

  async partEnd(handle) {
    const part = handle.current;
    if (!part) throw new ReceiveError('part 结束但未开始', 'invalid', 422);
    await part.handle.sync();
    await part.handle.close();
    part.handle = null;
    part.sha256 = part.hash.digest('hex');
    handle.current = null;
  }

  async abort(handle, error) {
    if (!handle) return;
    for (const part of handle.parts.values()) {
      if (part.handle) await part.handle.close().catch(() => {});
      part.handle = null;
    }
    await rm(handle.attemptDir, { recursive: true, force: true }).catch(() => {});
  }

  async inspectGroup(handle) {
    const manifestPart = handle.parts.get('manifest');
    if (!manifestPart) {
      throw new ReceiveError('清单 part 缺失', 'missing-manifest', 422);
    }
    const raw = await readFile(manifestPart.file);
    const declared = validateManifest(raw);
    if (declared.length > this.limits.maxFiles) {
      throw new ReceiveError('清单文件数超出上限', 'too-large', 413);
    }
    const entries = [];
    for (const item of declared) {
      const part = handle.parts.get(item.id);
      if (!part) {
        throw new ReceiveError(`清单引用的 ${item.id} 不在请求中`, 'missing-file', 422);
      }
      if (part.bytes !== item.bytes) {
        throw new ReceiveError(`文件 ${item.id} 字节数不符`, 'size-mismatch', 422);
      }
      if (part.sha256 !== item.sha256) {
        throw new ReceiveError(`文件 ${item.id} 摘要不符`, 'digest-mismatch', 422);
      }
      entries.push({ contentId: item.id, id: item.id, bytes: item.bytes, sha256: item.sha256, part });
    }
    for (const contentId of handle.parts.keys()) {
      if (contentId === 'manifest') continue;
      if (!declared.some(item => item.id === contentId)) {
        throw new ReceiveError(`part ${contentId} 未被清单引用`, 'unreferenced-part', 422);
      }
    }
    const groupDigest = sha256Hex(Buffer.from(canonicalGroup(entries), 'utf8'));
    return { raw, manifestSha256: sha256Hex(raw), entries, groupDigest };
  }

  async commit(handle) {
    const decision = await this.withLock(handle.deliveryId, async () => {
      const group = await this.inspectGroup(handle);
      const key = deliveryKey(handle.deliveryId);
      const mappingFile = path.join(this.deliveriesDir, key + '.json');
      const groupDir = path.join(this.groupsDir, key);
      const existing = (await pathExists(mappingFile)) ? await readJson(mappingFile).catch(() => null) : null;
      const priorReceipt = await this.readReceiptByKey(key);

      if (existing || priorReceipt) {
        const priorDigest = existing?.groupDigest ?? priorReceipt?.groupDigest;
        if (priorDigest === group.groupDigest && priorReceipt) {
          await this.verifyAcceptedGroup(key, priorReceipt);
          await this.auditCommit(handle, group, 'replayed', 200, priorReceipt.id);
          return { kind: 'replayed', status: 200, receipt: priorReceipt };
        }
        await this.recordAttempt({
          deliveryId: handle.deliveryId,
          outcome: 'conflict',
          status: 409,
          code: 'delivery-conflict',
          receivedBytes: handle.receivedBytes,
          parts: handle.parts.size,
          expectedDigest: priorDigest ?? null,
          actualDigest: group.groupDigest,
        });
        return {
          kind: 'conflict',
          status: 409,
          error: '相同交付号的内容与已接收组不一致',
          code: 'delivery-conflict',
          receipt: priorReceipt ?? null,
        };
      }

      const temporary = path.join(this.groupsDir, `.tmp-${handle.attemptId}`);
      await rm(temporary, { recursive: true, force: true });
      await mkdir(path.join(temporary, 'files'), { recursive: true });
      try {
        for (const entry of group.entries) {
          const destination = path.join(temporary, 'files', entry.sha256);
          if (await pathExists(destination)) {
            await rm(entry.part.file, { force: true });
          } else {
            await rename(entry.part.file, destination);
          }
        }
        await fsyncDir(path.join(temporary, 'files'));
        await atomicWrite(path.join(temporary, 'manifest.raw'), group.raw);
        await atomicWriteJson(path.join(temporary, 'manifest.json'), {
          deliveryId: handle.deliveryId,
          groupDigest: group.groupDigest,
          manifestSha256: group.manifestSha256,
          files: group.entries.map(entry => ({
            contentId: entry.contentId,
            id: entry.id,
            bytes: entry.bytes,
            sha256: entry.sha256,
          })),
        });
        await fsyncDir(temporary);
        if (await pathExists(groupDir)) {
          // Only reachable when a previous process crashed before writing a receipt.
          await rm(groupDir, { recursive: true, force: true });
        }
        await rename(temporary, groupDir);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      await fsyncDir(this.groupsDir);

      const receipt = {
        id: handle.deliveryId,
        deliveryId: handle.deliveryId,
        status: 'received',
        receivedAt: new Date().toISOString(),
        groupDigest: group.groupDigest,
        manifestSha256: group.manifestSha256,
        files: group.entries.map(entry => ({
          contentId: entry.contentId,
          id: entry.id,
          bytes: entry.bytes,
          sha256: entry.sha256,
          url: `/deliveries/${safeUrlPart(handle.deliveryId)}/files/${safeUrlPart(entry.id)}`,
        })),
      };
      // Receipt is the visibility switch: it is written only after every file
      // and the manifest are durable in the group directory.
      await atomicWriteJson(path.join(groupDir, 'receipt.json'), receipt);
      await atomicWriteJson(mappingFile, {
        deliveryId: handle.deliveryId,
        groupDigest: group.groupDigest,
        receiptId: receipt.id,
        committedAt: receipt.receivedAt,
      });
      await this.auditCommit(handle, group, 'received', 201, receipt.id);
      return { kind: 'received', status: 201, receipt };
    });
    await rm(handle.attemptDir, { recursive: true, force: true }).catch(() => {});
    return decision;
  }

  async auditCommit(handle, group, outcome, status, receiptId) {
    await this.recordAttempt({
      deliveryId: handle.deliveryId,
      outcome,
      status,
      code: outcome,
      receiptId,
      receivedBytes: handle.receivedBytes,
      parts: handle.parts.size,
      groupDigest: group.groupDigest,
      files: group.entries.map(entry => ({
        contentId: entry.contentId,
        bytes: entry.bytes,
        sha256: entry.sha256,
      })),
    });
  }

  async readReceiptByKey(key) {
    try {
      return await readJson(path.join(this.groupsDir, key, 'receipt.json'));
    } catch {
      return null;
    }
  }

  async getReceipt(deliveryId) {
    if (typeof deliveryId !== 'string' || deliveryId === '') return null;
    const key = deliveryKey(deliveryId);
    const receipt = await this.readReceiptByKey(key);
    if (!receipt) return null;
    if (receipt.deliveryId !== deliveryId) return null;
    return receipt;
  }

  async verifyAcceptedGroup(key, receipt) {
    if (!Array.isArray(receipt.files)) throw new ReceiveError('已接收收据损坏', 'corrupt-receipt', 500);
    for (const file of receipt.files) {
      const target = path.join(this.groupsDir, key, 'files', file.sha256);
      if (!(await pathExists(target))) {
        throw new ReceiveError('已接收组缺少文件', 'corrupt-group', 500);
      }
      const data = await readFile(target);
      if (data.length !== file.bytes || sha256Hex(data) !== file.sha256) {
        throw new ReceiveError('已接收组的文件与收据摘要不符', 'corrupt-group', 500);
      }
    }
  }

  async listFiles(deliveryId) {
    const receipt = await this.getReceipt(deliveryId);
    if (!receipt) return null;
    return {
      id: receipt.id,
      groupDigest: receipt.groupDigest,
      files: receipt.files.map(file => ({
        contentId: file.contentId,
        id: file.id,
        bytes: file.bytes,
        sha256: file.sha256,
        url: file.url,
      })),
    };
  }

  async openCommittedFile(deliveryId, contentId) {
    const key = deliveryKey(deliveryId);
    const receipt = await this.getReceipt(deliveryId);
    if (!receipt) return null;
    const file = receipt.files.find(entry => entry.id === contentId || entry.contentId === contentId);
    if (!file) return null;
    const target = path.join(this.groupsDir, key, 'files', file.sha256);
    if (!(await pathExists(target))) return null;
    return { file, path: target };
  }

  /**
   * Per-delivery view derived only from committed receipts plus the attempts
   * this process actually served.
   */
  async report() {
    return { attempts: this.attempts };
  }

  async stagingContents() {
    return readdir(this.stagingDir);
  }
}
