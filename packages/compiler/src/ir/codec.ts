/* The IR's binary encoding: the fields of every node and record, by name in
 * the order ir.ts declares them (codec.generated.ts), written without field
 * names or JSON structure.
 *
 * - A length, a union's member or arm index and a string reference are
 *   unsigned varints (7 bits per byte, low bits first).
 * - A number is one byte, 0 for an integer in the int32 range other than
 *   -0, followed by its zigzag varint, or 1 followed by its IEEE 754 bytes
 *   (little-endian), which keep NaN, the infinities and -0.
 * - A string is a varint: 0 for a new string, which also gives it the next
 *   index in the string table, otherwise one more than the index of a
 *   string the encoding already has. A new string's bytes follow, after a
 *   varint of twice their count: plus one when they are UTF-16LE code units
 *   (a string with a lone surrogate, which UTF-8 cannot spell), else UTF-8.
 * - A boolean is one byte.
 * - A field that can be absent or null starts with a byte: 0 absent, then 1
 *   for null and 2 for a value when both are possible, otherwise 1 for a
 *   value.
 *
 * An encoding starts with MAGIC and IR_CODEC_LAYOUT, a digest of the
 * generated coders, so a reader refuses bytes that other coders wrote. Decoded objects carry their fields in
 * declaration order, with absent optional fields left out; an object read
 * back has the key order of the object written when IrWriter.inOrder held. */
import type { IrFunction, IrModule } from "./ir.js";
import {
  IR_CODEC_LAYOUT,
  decodeIrFunction,
  decodeIrModule,
  encodeIrFunction,
  encodeIrModule,
} from "./codec.generated.js";

/** The first bytes of an encoding: "SCIR". */
const MAGIC = [0x53, 0x43, 0x49, 0x52];

/** Whether `value` has a surrogate code unit without its pair. */
function loneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
    if (unit > 0xdbff || next < 0xdc00 || next > 0xdfff) return true;
    index++;
  }
  return false;
}

export class IrWriter {
  private bytes = Buffer.allocUnsafe(1 << 16);
  private size = 0;
  private readonly strings = new Map<string, number>();
  /** The values of the string fields named `file` written so far. */
  readonly files = new Set<string>();
  private readonly scratch = Buffer.allocUnsafe(8);
  /** Whether every object written so far reads back with its own key order
   * (`keys`). False once one held a key its type does not declare, or its
   * keys in another order than the declaration's. */
  inOrder = true;

  /** Notes an object's own keys against its type's declared fields. The
   * decoder builds an object with its fields in declaration order, so an
   * object whose keys come in another order, or include one the type does
   * not declare, does not read back as it was. */
  keys(own: readonly string[], declared: readonly string[]): void {
    if (!this.inOrder) return;
    let at = 0;
    for (const key of own) {
      while (at < declared.length && declared[at] !== key) at++;
      if (at === declared.length) {
        this.inOrder = false;
        return;
      }
      at++;
    }
  }

  private reserve(count: number): void {
    if (this.size + count <= this.bytes.length) return;
    let capacity = this.bytes.length * 2;
    while (capacity < this.size + count) capacity *= 2;
    const grown = Buffer.allocUnsafe(capacity);
    this.bytes.copy(grown, 0, 0, this.size);
    this.bytes = grown;
  }

  byte(value: number): void {
    this.reserve(1);
    this.bytes[this.size++] = value;
  }

  /** A non-negative integer below 2^53. */
  length(value: number): void {
    this.reserve(8);
    while (value >= 0x80) {
      this.bytes[this.size++] = (value % 0x80) + 0x80;
      value = Math.floor(value / 0x80);
    }
    this.bytes[this.size++] = value;
  }

  bool(value: boolean): void {
    this.byte(value ? 1 : 0);
  }

  num(value: number): void {
    if (
      Number.isInteger(value) &&
      value >= -0x80000000 &&
      value <= 0x7fffffff &&
      !Object.is(value, -0)
    ) {
      this.byte(0);
      this.length(value < 0 ? -value * 2 - 1 : value * 2);
      return;
    }
    this.byte(1);
    this.scratch.writeDoubleLE(value, 0);
    this.reserve(8);
    this.scratch.copy(this.bytes, this.size, 0, 8);
    this.size += 8;
  }

  str(value: string): void {
    const known = this.strings.get(value);
    if (known !== undefined) {
      this.length(known + 1);
      return;
    }
    this.strings.set(value, this.strings.size);
    this.length(0);
    const utf8 = Buffer.byteLength(value, "utf8");
    // UTF-8 cannot spell a lone surrogate, so a string with one is written
    // as its UTF-16 code units.
    const units = utf8 !== value.length && loneSurrogate(value);
    const count = units ? value.length * 2 : utf8;
    this.length(count * 2 + (units ? 1 : 0));
    this.reserve(count);
    if (units) this.bytes.write(value, this.size, count, "utf16le");
    else this.bytes.write(value, this.size, count, "utf8");
    this.size += count;
  }

  /** What the encoding could not write, such as a node whose kind its
   * union does not declare, or null. Such an encoding does not decode. */
  refused: string | null = null;

  /** Notes that `what` could not be written (`refused`). */
  refuse(what: string): void {
    this.inOrder = false;
    this.refused ??= what;
  }

  /** A string field named `file`: a source file the encoding names. */
  file(value: string): void {
    this.files.add(value);
    this.str(value);
  }

  /** Raw bytes, after their count. */
  blob(bytes: Uint8Array): void {
    this.length(bytes.length);
    this.reserve(bytes.length);
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).copy(this.bytes, this.size);
    this.size += bytes.length;
  }

  /** The strings written so far, each once, in the order first written. */
  written(): IterableIterator<string> {
    return this.strings.keys();
  }

  /** Starts a new encoding in the same buffer. */
  reset(): void {
    this.size = 0;
    this.strings.clear();
    this.files.clear();
    this.inOrder = true;
    this.refused = null;
  }

  /** The bytes written so far. Throws when the encoding refused a value. */
  finish(): Buffer {
    if (this.refused !== null) throw new Error(`IR codec: cannot encode a ${this.refused}`);
    return this.bytes.subarray(0, this.size);
  }
}

export class IrReader {
  private offset = 0;
  private readonly strings: string[] = [];
  /** The last presence byte `tag` read. */
  lastTag = 0;

  constructor(private readonly bytes: Buffer) {}

  private fail(what: string): never {
    throw new Error(`IR codec: ${what} at byte ${this.offset}`);
  }

  byte(): number {
    if (this.offset >= this.bytes.length) this.fail("unexpected end");
    return this.bytes[this.offset++]!;
  }

  length(): number {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = this.byte();
      value += (byte % 0x80) * scale;
      if (byte < 0x80) return value;
      scale *= 0x80;
      if (scale > 2 ** 56) this.fail("varint too long");
    }
  }

  bool(): boolean {
    return this.byte() !== 0;
  }

  num(): number {
    const tag = this.byte();
    if (tag === 0) {
      const zigzag = this.length();
      return zigzag % 2 === 0 ? zigzag / 2 : -(zigzag + 1) / 2;
    }
    if (tag !== 1) this.fail("invalid number tag");
    if (this.offset + 8 > this.bytes.length) this.fail("unexpected end");
    const value = this.bytes.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }

  str(): string {
    const reference = this.length();
    if (reference > 0) {
      const known = this.strings[reference - 1];
      if (known === undefined) this.fail("invalid string reference");
      return known;
    }
    const spelled = this.length();
    const count = Math.floor(spelled / 2);
    if (this.offset + count > this.bytes.length) this.fail("unexpected end");
    const value =
      spelled % 2 === 0
        ? this.bytes.toString("utf8", this.offset, this.offset + count)
        : this.bytes.toString("utf16le", this.offset, this.offset + count);
    this.offset += count;
    this.strings.push(value);
    return value;
  }

  /** Raw bytes blob wrote, as a view of the bytes read. */
  blob(): Buffer {
    const count = this.length();
    if (this.offset + count > this.bytes.length) this.fail("unexpected end");
    const out = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  /** A presence byte below `limit`, kept in lastTag. */
  tag(limit: number, where: string): number {
    const tag = this.byte();
    if (tag >= limit) this.fail(`invalid presence byte for ${where}`);
    this.lastTag = tag;
    return tag;
  }

  /** Whether every byte was read. */
  done(): boolean {
    return this.offset === this.bytes.length;
  }
}

function header(w: IrWriter): void {
  for (const byte of MAGIC) w.byte(byte);
  w.str(IR_CODEC_LAYOUT);
}

function readHeader(r: IrReader): void {
  for (const byte of MAGIC) if (r.byte() !== byte) throw new Error("IR codec: not an IR encoding");
  const layout = r.str();
  if (layout !== IR_CODEC_LAYOUT)
    throw new Error(
      `IR codec: the encoding has layout ${layout}, this compiler reads ${IR_CODEC_LAYOUT}`,
    );
}

/** Whether `bytes` start like an encoding this module writes. */
export function isIrEncoding(bytes: Uint8Array): boolean {
  return MAGIC.every((byte, index) => bytes[index] === byte);
}

export function encodeModuleBinary(mod: IrModule): Buffer {
  const w = new IrWriter();
  header(w);
  encodeIrModule(w, mod);
  return w.finish();
}

export function decodeModuleBinary(bytes: Buffer): IrModule {
  const r = new IrReader(bytes);
  readHeader(r);
  const mod = decodeIrModule(r);
  if (!r.done()) throw new Error("IR codec: bytes after the module");
  return mod;
}

export function encodeFunctionBinary(fn: IrFunction): Buffer {
  const w = new IrWriter();
  header(w);
  encodeIrFunction(w, fn);
  return w.finish();
}

/** The writer encodeFunctionInOrder reuses: its result is a copy. */
const inOrderWriter = new IrWriter();

/** `fn`'s encoding when it reads back as `fn` is, every object with its
 * own key order (IrWriter.inOrder), or null. */
export function encodeFunctionInOrder(fn: IrFunction): Buffer | null {
  return encodeFunctionStrings(fn)?.bytes ?? null;
}

/** encodeFunctionInOrder's encoding of `fn`, with the strings it holds,
 * each once, and the files its fields named `file` hold (IrWriter.file), or
 * null. */
export function encodeFunctionStrings(fn: IrFunction): {
  readonly bytes: Buffer;
  readonly strings: readonly string[];
  readonly files: readonly string[];
} | null {
  const w = inOrderWriter;
  w.reset();
  header(w);
  encodeIrFunction(w, fn);
  // An encoding that refused a value is not in order either.
  return w.inOrder
    ? { bytes: Buffer.from(w.finish()), strings: [...w.written()], files: [...w.files] }
    : null;
}

/** A 64-bit digest of `fn`'s content, the same for functions whose fields
 * hold the same values in any key order, with the byte count of the
 * content it covers. It covers the binary encoding, or the JSON text when
 * the encoder refuses a value (IrWriter.refuse). */
export function functionDigest(fn: IrFunction): string {
  const w = inOrderWriter;
  w.reset();
  encodeIrFunction(w, fn);
  if (w.refused === null) return bytesDigest(w.finish());
  return `json:${bytesDigest(Buffer.from(JSON.stringify(fn), "utf8"))}`;
}

/** Two 32-bit multiply-xor lanes over `bytes`, FNV-1a's and one with
 * another offset and MurmurHash2's multiplier, and the byte count. */
function bytesDigest(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    a = Math.imul(a ^ byte, 0x01000193);
    b = Math.imul(b ^ byte, 0x5bd1e995);
  }
  const hex = (lane: number): string => (lane >>> 0).toString(16).padStart(8, "0");
  return `${bytes.length}:${hex(a)}${hex(b)}`;
}

export function decodeFunctionBinary(bytes: Buffer): IrFunction {
  const r = new IrReader(bytes);
  readHeader(r);
  const fn = decodeIrFunction(r);
  if (!r.done()) throw new Error("IR codec: bytes after the function");
  return fn;
}
