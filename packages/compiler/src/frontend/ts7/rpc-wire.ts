/** The pinned TypeScript 7 synchronous API uses MessagePack triples:
 * [message kind, binary method name, binary payload]. Keep framing separate
 * from process creation so the same client runs in Node and native scriptc. */
export const TS7_REQUEST = 1;
export const TS7_CALLBACK_RESPONSE = 2;
export const TS7_CALLBACK_ERROR = 3;
export const TS7_RESPONSE = 4;
export const TS7_ERROR = 5;
export const TS7_CALLBACK = 6;

export interface Ts7WireMessage {
  kind: number;
  method: string;
  payload: Uint8Array;
}

/** Transfers may be short. A zero-byte read denotes EOF, and a zero-byte
 * write is an error: neither is allowed to spin the synchronous client. */
export interface Ts7WireIo {
  /** The server process's ID where the transport knows it: the frontend reads
   * that process's resident memory to decide whether to keep the server for
   * the next load (services.ts). */
  readonly pid?: number | undefined;
  read: (buffer: Uint8Array, offset: number, length: number) => number;
  write: (buffer: Uint8Array, offset: number, length: number) => number;
  close: () => void;
}

export class Ts7ProtocolError extends Error {
  constructor(message: string) {
    super(`TypeScript API protocol: ${message}`);
    this.name = "Ts7ProtocolError";
  }
}

/** A response frame larger than the channel limit. The frame was read and
 * dropped, so the channel stays open: the caller can ask again in smaller
 * pieces. Any other protocol error poisons the stream. */
export class Ts7FrameLimitError extends Ts7ProtocolError {
  constructor(message: string) {
    super(message);
    this.name = "Ts7FrameLimitError";
  }
}

function binHeaderSize(length: number): number {
  return length < 256 ? 2 : length < 65536 ? 3 : 5;
}

function writeBinHeader(buffer: Uint8Array, offset: number, length: number): number {
  if (length < 256) {
    buffer[offset++] = 0xc4;
    buffer[offset++] = length;
  } else if (length < 65536) {
    buffer[offset++] = 0xc5;
    buffer[offset++] = length >>> 8;
    buffer[offset++] = length;
  } else {
    buffer[offset++] = 0xc6;
    buffer[offset++] = length >>> 24;
    buffer[offset++] = length >>> 16;
    buffer[offset++] = length >>> 8;
    buffer[offset++] = length;
  }
  return offset;
}

/** Own one channel's read-ahead bytes and closed state. An invalid frame
 * poisons the stream: continuing after a malformed length or partial write
 * would let one request consume another request's response. */
export class Ts7Wire {
  private readonly input = new Uint8Array(65536);
  private readonly output = new Uint8Array(4096);
  private inputOffset = 0;
  private inputLength = 0;
  private closed = false;

  /** The server process's ID, when the transport knows it. */
  get pid(): number | undefined {
    return this.io.pid;
  }

  constructor(
    private readonly io: Ts7WireIo,
    readonly maxPayloadBytes = 512 * 1024 * 1024,
    readonly maxMethodBytes = 65536,
  ) {
    if (
      !Number.isSafeInteger(maxPayloadBytes) ||
      maxPayloadBytes < 0 ||
      maxPayloadBytes > 0xffffffff ||
      !Number.isSafeInteger(maxMethodBytes) ||
      maxMethodBytes < 0 ||
      maxMethodBytes > 0xffffffff
    ) {
      throw new RangeError("TypeScript API frame limits must be unsigned 32-bit lengths");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inputOffset = 0;
    this.inputLength = 0;
    this.io.close();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Ts7ProtocolError("channel is closed");
  }

  private fail(message: string): never {
    // Preserve the protocol failure if cleanup also fails.
    try {
      this.close();
    } catch {
      /* cleanup cannot repair framing */
    }
    throw new Ts7ProtocolError(message);
  }

  private readByte(): number {
    if (this.inputOffset === this.inputLength) {
      const count = this.io.read(this.input, 0, this.input.length);
      if (!Number.isSafeInteger(count) || count < 0 || count > this.input.length) {
        this.fail("invalid read count");
      }
      if (count === 0) this.fail("unexpected end of stream");
      this.inputOffset = 0;
      this.inputLength = count;
    }
    return this.input[this.inputOffset++]!;
  }

  private readLength(label: string): number {
    const marker = this.readByte();
    let length = 0;
    if (marker === 0xc4) {
      length = this.readByte();
    } else if (marker === 0xc5) {
      length = this.readByte() * 256 + this.readByte();
    } else if (marker === 0xc6) {
      // Arithmetic keeps the unsigned upper half positive.
      length =
        this.readByte() * 16777216 +
        this.readByte() * 65536 +
        this.readByte() * 256 +
        this.readByte();
    } else {
      this.fail(`expected binary ${label}, got marker ${marker}`);
    }
    return length;
  }

  /** Consume `length` bytes without allocating them: a frame over the limit
   * is read and dropped so the channel stays usable for a smaller request.
   * The peer already serialized the frame; the client keeps its memory
   * bounded instead of closing the connection. */
  private discardBytes(length: number): void {
    let offset = 0;
    while (offset < length) {
      const buffered = this.inputLength - this.inputOffset;
      if (buffered > 0) {
        const take = Math.min(buffered, length - offset);
        this.inputOffset += take;
        offset += take;
        continue;
      }
      // The buffered input is empty, so the input buffer is free as a
      // scratch destination; the next fill resets its offsets.
      const take = Math.min(this.input.length, length - offset);
      const count = this.io.read(this.input, 0, take);
      if (!Number.isSafeInteger(count) || count < 0 || count > take)
        this.fail("invalid read count");
      if (count === 0) this.fail("unexpected end of stream");
      offset += count;
    }
  }

  private readBytes(length: number): Uint8Array {
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const buffered = this.inputLength - this.inputOffset;
      if (buffered > 0) {
        const take = Math.min(buffered, length - offset);
        result.set(this.input.subarray(this.inputOffset, this.inputOffset + take), offset);
        this.inputOffset += take;
        offset += take;
      } else if (length - offset >= this.input.length) {
        const count = this.io.read(result, offset, length - offset);
        if (!Number.isSafeInteger(count) || count < 0 || count > length - offset)
          this.fail("invalid read count");
        if (count === 0) this.fail("unexpected end of stream");
        offset += count;
      } else {
        result[offset++] = this.readByte();
      }
    }
    return result;
  }

  private writeBytes(bytes: Uint8Array, length: number): void {
    let offset = 0;
    while (offset < length) {
      const count = this.io.write(bytes, offset, length - offset);
      if (!Number.isSafeInteger(count) || count <= 0 || count > length - offset)
        this.fail("invalid write count");
      offset += count;
    }
  }

  read(): Ts7WireMessage {
    this.ensureOpen();
    try {
      const marker = this.readByte();
      if (marker !== 0x93) this.fail(`expected three-element tuple, got marker ${marker}`);
      let kind = this.readByte();
      if (kind === 0xcc) kind = this.readByte();
      if (kind < TS7_REQUEST || kind > TS7_CALLBACK) this.fail(`invalid message kind ${kind}`);
      const nameLength = this.readLength("method");
      if (nameLength > this.maxMethodBytes)
        this.fail(`method exceeds ${this.maxMethodBytes} bytes`);
      const name = this.readBytes(nameLength);
      const payloadLength = this.readLength("payload");
      if (payloadLength > this.maxPayloadBytes) {
        // Read past the frame so the next request on this channel can be
        // answered, then tell the caller a smaller request is needed. A
        // length far beyond the limit is a broken peer, not a large
        // answer: close instead of reading gigabytes of nothing.
        if (payloadLength > this.maxPayloadBytes * 4)
          this.fail(`payload exceeds ${this.maxPayloadBytes} bytes`);
        this.discardBytes(payloadLength);
        throw new Ts7FrameLimitError(
          `payload exceeds ${this.maxPayloadBytes} bytes (got ${payloadLength})`,
        );
      }
      const payload = this.readBytes(payloadLength);
      return {
        kind,
        method: Buffer.from(name.buffer, name.byteOffset, name.byteLength).toString("utf8"),
        payload,
      };
    } catch (error) {
      if (error instanceof Ts7FrameLimitError) throw error;
      try {
        this.close();
      } catch {
        /* preserve the original read failure */
      }
      throw error;
    }
  }

  write(kind: number, method: string, payload: Uint8Array): void {
    this.ensureOpen();
    if (!Number.isInteger(kind) || kind < TS7_REQUEST || kind > TS7_CALLBACK)
      throw new Ts7ProtocolError(`invalid message kind ${kind}`);
    const name = Buffer.from(method, "utf8");
    if (name.length > this.maxMethodBytes || payload.length > this.maxPayloadBytes)
      throw new Ts7ProtocolError("outgoing frame exceeds channel limits");
    const headerLength =
      2 + binHeaderSize(name.length) + name.length + binHeaderSize(payload.length);
    const length = headerLength + payload.length;
    // Small synchronous requests need one transfer and reuse bounded
    // framing storage. Large payloads keep the direct, uncopied write path.
    const combined = length <= this.output.length;
    const header = combined ? this.output : new Uint8Array(headerLength);
    header[0] = 0x93;
    header[1] = kind;
    let offset = writeBinHeader(header, 2, name.length);
    header.set(name, offset);
    offset += name.length;
    writeBinHeader(header, offset, payload.length);
    if (combined) header.set(payload, headerLength);
    try {
      this.writeBytes(header, combined ? length : headerLength);
      if (!combined) this.writeBytes(payload, payload.length);
    } catch (error) {
      try {
        this.close();
      } catch {
        /* preserve the original write failure */
      }
      throw error;
    }
  }
}
