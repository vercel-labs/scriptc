import { expect, test } from "vitest";
import { Ts7RpcClient } from "./rpc-client.js";
import { Ts7ProtocolError, Ts7Wire } from "./rpc-wire.js";

function frame(kind: number, method: string, payload: string): number[] {
  const name = Array.from(Buffer.from(method));
  const bytes = Array.from(Buffer.from(payload));
  if (name.length > 255 || bytes.length > 255) throw new Error("test frame exceeds bin8");
  return [0x93, kind, 0xc4, name.length, ...name, 0xc4, bytes.length, ...bytes];
}

function scripted(frames: number[][]) {
  const input = Uint8Array.from(frames.flat());
  let position = 0;
  let closes = 0;
  const output: number[] = [];
  const client = new Ts7RpcClient(
    new Ts7Wire({
      read(buffer, offset, length) {
        const count = Math.min(length, input.length - position, 3);
        buffer.set(input.subarray(position, position + count), offset);
        position += count;
        return count;
      },
      write(buffer, offset, length) {
        const count = Math.min(length, 2);
        output.push(...buffer.subarray(offset, offset + count));
        return count;
      },
      close() {
        closes++;
      },
    }),
  );
  return { client, output, closes: () => closes };
}

test("serves interleaved callbacks before returning the requested response", () => {
  const io = scripted([
    frame(6, "readFile", '"/a.ts"'),
    frame(6, "exists", '"/b.ts"'),
    frame(4, "parse", "parsed"),
    frame(4, "echo", "next"),
  ]);
  const calls: string[] = [];
  io.client.registerCallback("readFile", (payload) => {
    calls.push(payload);
    return '{"content":""}';
  });
  io.client.registerCallback("exists", () => "false");
  expect(io.client.requestText("parse", "input")).toBe("parsed");
  expect(io.client.requestText("echo", "next")).toBe("next");
  expect(calls).toEqual(['"/a.ts"']);
  expect(io.output).toEqual([
    ...frame(1, "parse", "input"),
    ...frame(2, "readFile", '{"content":""}'),
    ...frame(2, "exists", "false"),
    ...frame(1, "echo", "next"),
  ]);
  expect(io.client.timing()).toEqual({
    requests: 2,
    bytesSent: 9,
    bytesReceived: 10,
    callbacks: 2,
  });
  io.client.close();
  io.client.close();
  expect(io.closes()).toBe(1);
});

test("a complete server error permits the next request", () => {
  const io = scripted([frame(5, "query", "checker panic"), frame(4, "echo", "ok")]);
  expect(() => io.client.requestText("query", "{}")).toThrow("checker panic");
  expect(io.closes()).toBe(0);
  expect(io.client.requestText("echo", "ok")).toBe("ok");
  expect(io.client.timing().requests).toBe(2);
});

test("a server error with an empty payload still names the failed request", () => {
  const io = scripted([frame(5, "getTypeAtLocation", ""), frame(4, "echo", "ok")]);
  let error: Error | undefined;
  try {
    io.client.requestText("getTypeAtLocation", "{}");
  } catch (e) {
    error = e as Error;
  }
  expect(error).toBeDefined();
  expect(error!.message.trim()).not.toBe("");
  expect(error!.message).toContain("getTypeAtLocation");
  expect(error!.message).toContain("without a message");
  // The panic shape is what the lowering's fences recognize.
  expect(error!.message.startsWith("panic:")).toBe(true);
  expect(io.closes()).toBe(0);
  expect(io.client.requestText("echo", "ok")).toBe("ok");
});

test.each([2, 3, 1])("invalid server message kind %i poisons the channel", (kind) => {
  const io = scripted([frame(kind, "echo", "bad")]);
  expect(() => io.client.requestText("echo", "hello")).toThrow("unexpected server message");
  expect(() => io.client.requestText("echo", "again")).toThrow("closed");
  expect(io.closes()).toBe(1);
});

test.each([4, 5])("mismatched method on response kind %i poisons the channel", (kind) => {
  const io = scripted([frame(kind, "another", "bad")]);
  expect(() => io.client.requestText("echo", "hello")).toThrow("response method mismatch");
  expect(io.closes()).toBe(1);
});

test("unknown callbacks send an error and close instead of waiting forever", () => {
  const io = scripted([frame(6, "missing", "null")]);
  expect(() => io.client.requestText("parse", "{}")).toThrow("unknown callback: missing");
  expect(io.output).toEqual([
    ...frame(1, "parse", "{}"),
    ...frame(3, "missing", "unknown callback: missing"),
  ]);
  expect(io.closes()).toBe(1);
});

test.each([new Error("disk failure"), "disk failure"])(
  "throwing callbacks send a server error",
  (error) => {
    const io = scripted([frame(6, "readFile", '"/a"')]);
    io.client.registerCallback("readFile", () => {
      throw error;
    });
    expect(() => io.client.requestText("parse", "{}")).toThrow(
      "callback readFile failed: disk failure",
    );
    expect(io.output).toEqual([
      ...frame(1, "parse", "{}"),
      ...frame(3, "readFile", "disk failure"),
    ]);
    expect(io.closes()).toBe(1);
  },
);

test("reentrant requests fail before sending a nested request", () => {
  const io = scripted([frame(6, "nested", "null")]);
  io.client.registerCallback("nested", () => io.client.requestText("inner", "null"));
  expect(() => io.client.requestText("outer", "null")).toThrow("reentrant requests");
  expect(io.output).toEqual([
    ...frame(1, "outer", "null"),
    ...frame(3, "nested", "TypeScript API protocol: reentrant requests are not supported"),
  ]);
  expect(io.closes()).toBe(1);
});

test("a callback may handle a refused reentry and still answer the outer request", () => {
  const io = scripted([frame(6, "nested", "null"), frame(4, "outer", "ok")]);
  io.client.registerCallback("nested", () => {
    expect(() => io.client.requestText("inner", "null")).toThrow(Ts7ProtocolError);
    return "recovered";
  });
  expect(io.client.requestText("outer", "null")).toBe("ok");
  expect(io.output).toEqual([...frame(1, "outer", "null"), ...frame(2, "nested", "recovered")]);
  expect(io.closes()).toBe(0);
});

test("callback registrations can be replaced only between requests", () => {
  const io = scripted([frame(6, "value", "null"), frame(4, "query", "ok")]);
  io.client.registerCallback("value", () => "old");
  io.client.registerCallback("value", () => {
    expect(() => io.client.registerCallback("next", () => "")).toThrow("during a request");
    return "new";
  });
  expect(io.client.requestText("query", "null")).toBe("ok");
  expect(io.output).toEqual([...frame(1, "query", "null"), ...frame(2, "value", "new")]);
  io.client.close();
  expect(() => io.client.registerCallback("value", () => "")).toThrow("closed");
});

test("an empty response is a successful binary reply", () => {
  const io = scripted([frame(4, "release", "")]);
  expect(io.client.requestBytes("release", Buffer.from("{}"))).toEqual(new Uint8Array());
  expect(io.client.timing().bytesReceived).toBe(0);
});

test("timing snapshots cannot mutate client counters", () => {
  const io = scripted([frame(4, "echo", "héllo")]);
  expect(io.client.requestText("echo", "🌍")).toBe("héllo");
  const before = io.client.timing();
  expect(before.bytesSent).toBe(4);
  expect(before.bytesReceived).toBe(6);
  before.requests = 1000;
  expect(io.client.timing().requests).toBe(1);
});
