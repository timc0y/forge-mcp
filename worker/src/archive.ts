import type { GitHubRequest, RepoRef } from './contracts';
import { formatRepo } from './contracts';
import { ForgeError } from './errors';
import { CONTEXT_LIMITS, RequestBudget, requirePath, requireSha } from './evidence';
import { githubFailure } from './snapshot';

function archiveError(message: string): never {
  throw new ForgeError({ code: 'FORGE_UPSTREAM_UNAVAILABLE', message: `Committed archive is incomplete or unsupported: ${message}. No absence conclusion was made.` });
}
/** Retains at most one upstream chunk plus the explicitly requested bounded record. */
class StreamReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunk = new Uint8Array(0);
  private offset = 0;
  private total = 0;
  constructor(stream: ReadableStream<Uint8Array>, private readonly budget: RequestBudget) { this.reader = stream.getReader(); }
  async take(size: number, retain = true): Promise<Uint8Array> {
    if (!Number.isSafeInteger(size) || size < 0 || size > CONTEXT_LIMITS.unpackedBytes) archiveError('invalid record length');
    const result = new Uint8Array(retain ? size : 0);
    let written = 0;
    while (written < size) {
      this.budget.assert();
      if (this.offset === this.chunk.length) {
        const part = await this.reader.read();
        if (part.done) archiveError('premature end of stream');
        this.total += part.value.byteLength;
        if (this.total > CONTEXT_LIMITS.unpackedBytes) throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: 'Unpacked archive exceeded its streaming byte ceiling.' });
        this.chunk = part.value;
        this.offset = 0;
      }
      const count = Math.min(size - written, this.chunk.length - this.offset);
      if (retain) result.set(this.chunk.subarray(this.offset, this.offset + count), written);
      this.offset += count;
      written += count;
    }
    return result;
  }
  async finish(): Promise<void> {
    if (this.chunk.subarray(this.offset).some((byte) => byte !== 0)) archiveError('data after archive terminator');
    for (;;) {
      this.budget.assert();
      const part = await this.reader.read();
      if (part.done) return;
      this.total += part.value.byteLength;
      if (this.total > CONTEXT_LIMITS.unpackedBytes || part.value.some((byte) => byte !== 0)) archiveError('invalid trailing archive data');
    }
  }
  async close(): Promise<void> { await this.reader.cancel().catch(() => {}); }
}
const decoder = new TextDecoder('utf-8', { fatal: true });
function string(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  return decoder.decode(nul < 0 ? bytes : bytes.subarray(0, nul));
}
function octal(bytes: Uint8Array): number {
  const value = string(bytes).trim();
  if (!/^[0-7]+$/.test(value)) archiveError('non-octal numeric header');
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result)) archiveError('oversized numeric header');
  return result;
}
function headerSize(header: Uint8Array): number {
  const checksum = octal(header.subarray(148, 156));
  let actual = 0;
  for (let index = 0; index < header.length; index++) actual += index >= 148 && index < 156 ? 32 : header[index]!;
  if (actual !== checksum) archiveError('header checksum mismatch');
  return octal(header.subarray(124, 136));
}
function pax(bytes: Uint8Array): Map<string, string> {
  const fields = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) archiveError('invalid PAX header');
    const number = decoder.decode(bytes.subarray(offset, space));
    if (!/^[1-9]\d*$/.test(number)) archiveError('invalid PAX length');
    const length = Number(number);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) archiveError('invalid PAX record boundary');
    const entry = decoder.decode(bytes.subarray(space + 1, offset + length - 1));
    const equal = entry.indexOf('=');
    if (equal < 1) archiveError('invalid PAX assignment');
    fields.set(entry.slice(0, equal), entry.slice(equal + 1));
    offset += length;
  }
  return fields;
}
export interface ArchiveCoverage { scanned: number; coverage: 'complete' | 'bounded'; omissions: string[] }
/** One acquisition, no extraction to disk, no symlink traversal and no retained repository mirror. */
export async function scanArchive(
  gh: GitHubRequest,
  repo: RepoRef,
  sha: string,
  budget: RequestBudget,
  include: (path: string) => boolean,
  visit: (path: string, text: string) => void | Promise<void>
): Promise<ArchiveCoverage> {
  requireSha(sha);
  const response = await gh(`/repos/${formatRepo(repo)}/tarball/${sha}`, { stream: true, maxBytes: CONTEXT_LIMITS.compressedBytes, signal: AbortSignal.timeout(budget.remaining()) });
  if (response.status !== 200 || !response.stream) githubFailure(response.status, 'a streaming committed archive');
  let compressed = 0;
  const guarded = response.stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      compressed += chunk.byteLength;
      if (compressed > CONTEXT_LIMITS.compressedBytes) throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: 'Compressed archive exceeds its byte ceiling.' });
      controller.enqueue(chunk);
    }
  })).pipeThrough(new DecompressionStream('gzip'));
  const reader = new StreamReader(guarded, budget);
  const omissions: string[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  let root: string | null = null;
  let pendingPath: string | null = null;
  try {
    for (;;) {
      const header = await reader.take(512);
      if (header.every((byte) => byte === 0)) {
        const second = await reader.take(512);
        if (second.some((byte) => byte !== 0)) archiveError('single zero block before another entry');
        await reader.finish();
        break;
      }
      const size = headerSize(header);
      const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]!);
      let name = string(header.subarray(0, 100));
      const prefix = string(header.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
      if (type === 'L' || type === 'x' || type === 'g') {
        if (size > 64 * 1024) archiveError('extended header exceeds its bound');
        const body = await reader.take(size);
        await reader.take((512 - size % 512) % 512, false);
        if (type === 'L') pendingPath = string(body);
        else {
          const fields = pax(body);
          if (fields.has('size') || fields.has('GNU.sparse.map')) archiveError('unsupported PAX size/sparse override');
          if (type === 'g' && fields.has('path')) archiveError('global PAX path override');
          if (fields.has('path')) pendingPath = fields.get('path')!;
        }
        continue;
      }
      if (pendingPath !== null) { name = pendingPath; pendingPath = null; }
      const parts = name.replace(/\/$/, '').split('/');
      if (!parts[0] || parts.some((part) => !part || part === '.' || part === '..') || name.startsWith('/') || name.includes('\\')) archiveError('unsafe member path');
      if (root === null) root = parts[0]!;
      if (root !== parts[0]) archiveError('multiple archive roots');
      const path = parts.slice(1).join('/');
      if (path) requirePath(path);
      if (type === '5' || !path) {
        await reader.take(size + (512 - size % 512) % 512, false);
        continue;
      }
      if (++scanned > 5000) archiveError('file-count ceiling reached');
      if (seen.has(path)) archiveError('duplicate member path');
      seen.add(path);
      const wanted = include(path);
      const readable = type === '0' && size <= CONTEXT_LIMITS.sourceBytes;
      if (wanted && !readable && omissions.length < 50) omissions.push(`${path}: ${type === '0' ? 'oversized' : 'non-regular member'}`);
      const body = await reader.take(size, wanted && readable);
      await reader.take((512 - size % 512) % 512, false);
      if (wanted && readable) {
        if (body.includes(0)) { if (omissions.length < 50) omissions.push(`${path}: binary`); continue; }
        let text: string;
        try { text = decoder.decode(body); } catch { if (omissions.length < 50) omissions.push(`${path}: invalid UTF-8`); continue; }
        await visit(path, text);
      }
    }
  } finally {
    budget.downloaded += compressed;
    await reader.close();
  }
  return { scanned, coverage: omissions.length ? 'bounded' : 'complete', omissions };
}
export interface LiteralHit { path: string; count: number; lines: number[] }
export async function findInSnapshot(gh: GitHubRequest, repo: RepoRef, sha: string, needle: string, budget: RequestBudget, prefix = ''): Promise<ArchiveCoverage & { hits: LiteralHit[]; matchedFiles: number }> {
  if (!needle || needle.length > 512) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Exact search requires 1–512 characters.' });
  if (prefix) requirePath(prefix);
  const hits: LiteralHit[] = [];
  let matchedFiles = 0;
  const coverage = await scanArchive(gh, repo, sha, budget, (path) => !prefix || path === prefix || path.startsWith(`${prefix}/`), (path, text) => {
    const lines: number[] = [];
    let count = 0;
    let offset = 0;
    for (;;) {
      const index = text.indexOf(needle, offset);
      if (index === -1) break;
      count++;
      if (lines.length < 10) lines.push(text.slice(0, index).split('\n').length);
      offset = index + needle.length;
    }
    if (count) { matchedFiles++; if (hits.length < 50) hits.push({ path, count, lines }); }
  });
  return { ...coverage, coverage: coverage.coverage === 'bounded' || matchedFiles > hits.length ? 'bounded' : 'complete', hits, matchedFiles };
}
