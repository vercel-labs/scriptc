import { describe, expect, test } from "vitest";
import { Ts7FrameLimitError, Ts7ProtocolError, Ts7Wire, type Ts7WireIo } from "./rpc-wire.js";

function memory(bytes: Uint8Array = new Uint8Array(), readSize = Infinity, writeSize = Infinity) {
  let position = 0;
  let closes = 0;
  const output: number[] = [];
  const io: Ts7WireIo = {
    read(buffer, offset, length) {
      const size = Math.min(length, readSize, bytes.length - position);
      buffer.set(bytes.subarray(position, position + size), offset);
      position += size;
      return size;
    },
    write(buffer, offset, length) {
      const size = Math.min(length, writeSize);
      output.push(...buffer.subarray(offset, offset + size));
      return size;
    },
    close() {
      closes++;
    },
  };
  return { io, output, closes: () => closes };
}

// These are protocol bytes, independent of the production encoder.
const echo = Uint8Array.from([0x93, 4, 0xc4, 4, 101, 99, 104, 111, 0xc4, 3, 0, 128, 255]);

describe("TypeScript MessagePack wire framing", () => {
  test.each([1, 2, 3, 7, 65536])("decodes fragmented reads of %i bytes", (readSize) => {
    const io = memory(echo, readSize);
    const wire = new Ts7Wire(io.io);
    expect(wire.read()).toEqual({
      kind: 4,
      method: "echo",
      payload: Uint8Array.from([0, 128, 255]),
    });
    expect(io.closes()).toBe(0);
  });

  test.each([1, 2, 7, 65536])("completes short writes of %i bytes", (writeSize) => {
    const io = memory(undefined, Infinity, writeSize);
    new Ts7Wire(io.io).write(4, "echo", Uint8Array.from([0, 128, 255]));
    expect(Uint8Array.from(io.output)).toEqual(echo);
  });

  test("retains read-ahead bytes for the next message", () => {
    const both = new Uint8Array(echo.length * 2);
    both.set(echo);
    both.set(echo, echo.length);
    const io = memory(both);
    const wire = new Ts7Wire(io.io);
    expect(wire.read().method).toBe("echo");
    expect(wire.read().payload).toEqual(Uint8Array.from([0, 128, 255]));
    expect(() => wire.read()).toThrow("unexpected end of stream");
    expect(io.closes()).toBe(1);
  });

  test("coalesces small frames and keeps large payloads on the direct path", () => {
    const channel = memory();
    const transfer = channel.io.write;
    const lengths: number[] = [];
    channel.io.write = (buffer, offset, length) => {
      lengths.push(length);
      return transfer(buffer, offset, length);
    };
    const wire = new Ts7Wire(channel.io);
    const payloads = [new Uint8Array([7, 8]), new Uint8Array(5000).fill(9), new Uint8Array([10])];
    for (const payload of payloads) wire.write(4, "echo", payload);
    expect(lengths).toEqual([12, 11, 5000, 11]);
    const reader = new Ts7Wire(memory(Uint8Array.from(channel.output)).io);
    for (const payload of payloads)
      expect(reader.read()).toEqual({ kind: 4, method: "echo", payload });
  });

  test("accepts uint8 message kind encoding and an empty method/payload", () => {
    const io = memory(Uint8Array.from([0x93, 0xcc, 6, 0xc4, 0, 0xc4, 0]));
    expect(new Ts7Wire(io.io).read()).toEqual({ kind: 6, method: "", payload: new Uint8Array() });
  });

  test.each([
    [0, [0xc4, 0]],
    [255, [0xc4, 255]],
    [256, [0xc5, 1, 0]],
    [65535, [0xc5, 255, 255]],
    [65536, [0xc6, 0, 1, 0, 0]],
    [140000, [0xc6, 0, 2, 34, 224]],
  ] as const)("encodes and decodes bin length %i", (length, header) => {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = i % 256;
    const written = memory(undefined, Infinity, 4096);
    new Ts7Wire(written.io).write(1, "x", bytes);
    expect(written.output.slice(0, 5 + header.length)).toEqual([0x93, 1, 0xc4, 1, 120, ...header]);
    expect(written.output.slice(5 + header.length)).toEqual(Array.from(bytes));
    const reader = memory(Uint8Array.from(written.output), 32769);
    expect(new Ts7Wire(reader.io).read()).toEqual({ kind: 1, method: "x", payload: bytes });
  });

  test("method lengths count UTF8 bytes and use bin16/bin32", () => {
    for (const name of ["é".repeat(128), "x".repeat(65536), "\uFEFF方法🌍"]) {
      const written = memory(undefined, Infinity, 4096);
      new Ts7Wire(written.io).write(6, name, new Uint8Array());
      const encoded = Buffer.from(name);
      const headerSize = encoded.length < 256 ? 2 : encoded.length < 65536 ? 3 : 5;
      expect(written.output[2]).toBe(headerSize === 2 ? 0xc4 : headerSize === 3 ? 0xc5 : 0xc6);
      expect(written.output.slice(2 + headerSize, 2 + headerSize + encoded.length)).toEqual(
        Array.from(encoded),
      );
      expect(new Ts7Wire(memory(Uint8Array.from(written.output), 257).io).read().method).toBe(name);
    }
  });

  test.each([
    [[0x92], "three-element tuple"],
    [[0x93, 0], "message kind"],
    [[0x93, 7], "message kind"],
    [[0x93, 0xff], "message kind"],
    [[0x93, 0xcd], "message kind"],
    [[0x93, 4, 0xa0], "binary method"],
    [[0x93, 4, 0xc4, 0, 0xc0], "binary payload"],
  ] as const)("rejects malformed frame %j", (bytes, message) => {
    const io = memory(Uint8Array.from(bytes));
    const wire = new Ts7Wire(io.io);
    expect(() => wire.read()).toThrow(message);
    expect(() => wire.read()).toThrow("closed");
    wire.close();
    expect(io.closes()).toBe(1);
  });

  test("rejects every truncated prefix of a frame and closes once", () => {
    for (let end = 0; end < echo.length; end++) {
      const io = memory(echo.subarray(0, end), 1);
      const wire = new Ts7Wire(io.io);
      expect(() => wire.read(), `prefix ${end}`).toThrow("end of stream");
      wire.close();
      expect(io.closes()).toBe(1);
    }
  });

  test.each([
    [[0x93, 4, 0xc6, 0x80, 0, 0, 0], "method exceeds"],
    [[0x93, 4, 0xc4, 0, 0xc6, 0xff, 0xff, 0xff, 0xff], "payload exceeds"],
    [[0x93, 4, 0xc4, 0, 0xc4, 5], "end of stream"],
  ] as const)("a truncated over-limit frame closes the channel %j", (prefix, message) => {
    const io = memory(Uint8Array.from(prefix));
    // bin32 lengths are parsed unsigned: the drain asks for their bytes
    // instead of allocating a negative or enormous buffer.
    expect(() => new Ts7Wire(io.io, 4, 4).read()).toThrow(message);
    expect(io.closes()).toBe(1);
  });

  test("outgoing validation does not write or poison the wire", () => {
    const io = memory();
    const wire = new Ts7Wire(io.io, 3, 4);
    expect(() => wire.write(4, "large", new Uint8Array())).toThrow("limits");
    expect(() => wire.write(4, "echo", new Uint8Array(4))).toThrow("limits");
    for (const kind of [0, 7, -1, 1.5, NaN, Infinity]) {
      expect(() => wire.write(kind, "", new Uint8Array())).toThrow("message kind");
    }
    expect(io.output).toEqual([]);
    expect(io.closes()).toBe(0);
    wire.write(4, "echo", Uint8Array.from([0, 128, 255]));
    expect(io.output).toEqual(Array.from(echo));
  });

  test.each([-1, 1.5, NaN, Infinity, 0x100000000])("rejects invalid frame limit %s", (limit) => {
    expect(() => new Ts7Wire(memory().io, limit)).toThrow(RangeError);
    expect(() => new Ts7Wire(memory().io, 1, limit)).toThrow(RangeError);
  });

  test.each([-1, 0.5, NaN, Infinity, 65537])("rejects invalid read count %s", (count) => {
    const io = memory();
    io.io.read = () => count;
    expect(() => new Ts7Wire(io.io).read()).toThrow("invalid read count");
    expect(io.closes()).toBe(1);
  });

  test.each([-1, 0, 0.5, NaN, Infinity, 1000])("rejects invalid write count %s", (count) => {
    const io = memory();
    io.io.write = () => count;
    expect(() => new Ts7Wire(io.io).write(1, "echo", new Uint8Array())).toThrow(
      "invalid write count",
    );
    expect(io.closes()).toBe(1);
  });

  test("a failed cleanup does not replace the framing or I/O error", () => {
    const failure = new Error("read failed");
    const io = memory();
    io.io.read = () => {
      throw failure;
    };
    io.io.close = () => {
      throw new Error("cleanup failed");
    };
    const wire = new Ts7Wire(io.io);
    expect(() => wire.read()).toThrow(failure);
    expect(() => wire.read()).toThrow(Ts7ProtocolError);
    expect(() => wire.close()).not.toThrow();
  });

  test.each([7, 65536])(
    "drains an over-limit frame of %i byte reads and keeps the channel open",
    (readSize) => {
      const oversize = 1000;
      const frame = new Uint8Array(9 + 4 + oversize + echo.length);
      frame.set([0x93, 4, 0xc4, 4, 101, 99, 104, 111, 0xc6]);
      frame.set(
        [oversize >>> 24, (oversize >>> 16) & 255, (oversize >>> 8) & 255, oversize & 255],
        9,
      );
      frame.set(echo, 13 + oversize);
      const io = memory(frame, readSize);
      // 1000 bytes is over the limit but within the drain cap (4 x limit).
      const wire = new Ts7Wire(io.io, 400);
      expect(() => wire.read()).toThrow(Ts7FrameLimitError);
      expect(io.closes()).toBe(0);
      expect(wire.read()).toEqual({
        kind: 4,
        method: "echo",
        payload: Uint8Array.from([0, 128, 255]),
      });
    },
  );

  test("a partial write failure makes further writes impossible", () => {
    const io = memory();
    let writes = 0;
    io.io.write = () => {
      if (++writes === 1) return 1;
      throw new Error("pipe gone");
    };
    const wire = new Ts7Wire(io.io);
    expect(() => wire.write(1, "echo", new Uint8Array())).toThrow("pipe gone");
    expect(() => wire.write(1, "echo", new Uint8Array())).toThrow("closed");
    expect(writes).toBe(2);
    expect(io.closes()).toBe(1);
  });
});
