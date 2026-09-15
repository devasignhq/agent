// A Playwright trace records the browser context's storageState and every request's cookies,
// so a signed-in run's trace.zip is rewritten with those values redacted before it is uploaded.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { redact, type RedactOptions } from "./boot.js";

type ZipEntry = { name: Buffer; madeBy: number; flags: number; method: number; time: number; date: number; crc: number; size: number; external: number; raw: Buffer };

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const MAX32 = 0xffffffff;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf: Buffer): number {
  let c = MAX32;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ MAX32) >>> 0;
}

export function readZip(zip: Buffer): ZipEntry[] {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("no end of central directory");
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  if (count === 0xffff || p === MAX32) throw new Error("zip64 is not supported");
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== CENTRAL) throw new Error("bad central directory entry");
    const flags = zip.readUInt16LE(p + 8);
    const csize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    if (flags & 1) throw new Error("encrypted entry");
    if (csize === MAX32 || size === MAX32 || local === MAX32) throw new Error("zip64 is not supported");
    if (zip.readUInt32LE(local) !== LOCAL) throw new Error("bad local header");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + csize > zip.length) throw new Error("entry runs past the end of the file");
    out.push({
      name: zip.subarray(p + 46, p + 46 + nameLen),
      madeBy: zip.readUInt16LE(p + 4),
      flags,
      method: zip.readUInt16LE(p + 10),
      time: zip.readUInt16LE(p + 12),
      date: zip.readUInt16LE(p + 14),
      crc: zip.readUInt32LE(p + 16),
      size,
      external: zip.readUInt32LE(p + 38),
      raw: zip.subarray(start, start + csize),
    });
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return out;
}

export function entryBytes(e: ZipEntry): Buffer {
  const bytes = e.method === 0 ? e.raw : e.method === 8 ? inflateRawSync(e.raw) : null;
  if (!bytes || bytes.length !== e.size) throw new Error(`unreadable entry ${e.name.toString()}`);
  return bytes;
}

// Sizes and CRCs sit in each local header, so no entry needs a trailing data descriptor.
function writeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    if (offset > MAX32) throw new Error("zip64 is not supported");
    const flags = e.flags & ~0x8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt16LE(e.time, 10);
    local.writeUInt16LE(e.date, 12);
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.raw.length, 18);
    local.writeUInt32LE(e.size, 22);
    local.writeUInt16LE(e.name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CENTRAL, 0);
    cd.writeUInt16LE(e.madeBy, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(e.time, 12);
    cd.writeUInt16LE(e.date, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.raw.length, 20);
    cd.writeUInt32LE(e.size, 24);
    cd.writeUInt16LE(e.name.length, 28);
    cd.writeUInt32LE(e.external, 38);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, e.name, e.raw);
    central.push(cd, e.name);
    offset += 30 + e.name.length + e.raw.length;
  }
  const dir = Buffer.concat(central);
  if (offset > MAX32 || entries.length >= 0xffff) throw new Error("zip64 is not supported");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

// Binary resources (screenshots, fonts) carry NUL bytes early; everything else is scrubbed as text.
function redactEntry(bytes: Buffer, opts: RedactOptions): Buffer | null {
  if (bytes.subarray(0, 8192).includes(0)) return null;
  const utf8 = bytes.toString("utf8");
  const encoding = Buffer.from(utf8, "utf8").equals(bytes) ? "utf8" : "latin1";
  const text = encoding === "utf8" ? utf8 : bytes.toString("latin1");
  const out = redact(text, { ...opts, json: true });
  return out === text ? null : Buffer.from(out, encoding);
}

/** Rewrites the trace in place; one that cannot be read or rewritten is removed rather than uploaded. */
export function redactTrace(file: string, opts: RedactOptions): void {
  try {
    let changed = false;
    const entries = readZip(readFileSync(file)).map((e) => {
      const next = redactEntry(entryBytes(e), opts);
      if (!next) return e;
      changed = true;
      return { ...e, method: 8, raw: deflateRawSync(next), crc: crc32(next), size: next.length };
    });
    if (changed) writeFileSync(file, writeZip(entries));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    try {
      rmSync(file, { force: true });
    } catch {
      // not a file we can remove either
    }
  }
}
