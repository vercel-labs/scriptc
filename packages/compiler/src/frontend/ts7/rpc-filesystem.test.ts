import { expect, test } from "vitest";
import { Ts7RpcClient } from "./rpc-client.js";
import {
  registerTs7FileSystem,
  TS7_FILE_SYSTEM_CALLBACKS,
  type Ts7FileSystem,
} from "./rpc-filesystem.js";
import { Ts7Wire } from "./rpc-wire.js";

const fallback: Ts7FileSystem = {
  readFile: () => undefined,
  fileExists: () => undefined,
  directoryExists: () => undefined,
  realpath: () => undefined,
  getAccessibleEntries: () => undefined,
};

function callback(
  name: string,
  fs: Ts7FileSystem,
  payload = JSON.stringify("/file.ts"),
  ts71 = false,
) {
  const incoming: number[] = [];
  const encoded = new Ts7Wire({
    read: () => 0,
    write: (buffer, offset, length) => {
      incoming.push(...buffer.subarray(offset, offset + length));
      return length;
    },
    close: () => {},
  });
  encoded.write(6, name, Buffer.from(payload));
  encoded.write(4, "query", new Uint8Array());
  const outgoing: number[] = [];
  let position = 0;
  let closed = false;
  const client = new Ts7RpcClient(
    new Ts7Wire({
      read(buffer, offset, length) {
        const chunk = incoming.slice(position, position + length);
        buffer.set(chunk, offset);
        position += chunk.length;
        return chunk.length;
      },
      write(buffer, offset, length) {
        outgoing.push(...buffer.subarray(offset, offset + length));
        return length;
      },
      close() {
        closed = true;
      },
    }),
  );
  registerTs7FileSystem(client, fs, () => ts71);
  let error: unknown;
  try {
    client.requestText("query", "null");
  } catch (caught) {
    error = caught;
  }
  let offset = 0;
  const reader = new Ts7Wire({
    read(buffer, start, length) {
      const chunk = outgoing.slice(offset, offset + length);
      buffer.set(chunk, start);
      offset += chunk.length;
      return chunk.length;
    },
    write: () => 0,
    close: () => {},
  });
  expect(reader.read().method).toBe("query");
  const response = reader.read();
  return { kind: response.kind, text: Buffer.from(response.payload).toString(), error, closed };
}

test.each([
  [undefined, ""],
  [null, '{"content":null}'],
  ["", '{"content":""}'],
  ["\uFEFFhéllo🌍\n", '{"content":"\uFEFFhéllo🌍\\n"}'],
] as const)("readFile preserves the meaning of %s", (content, text) => {
  expect(callback("readFile", { ...fallback, readFile: () => content })).toEqual({
    kind: 2,
    text,
    error: undefined,
    closed: false,
  });
});

test.each(TS7_FILE_SYSTEM_CALLBACKS.split(","))("%s delegates undefined to the server", (name) => {
  expect(callback(name, fallback)).toEqual({ kind: 2, text: "", error: undefined, closed: false });
});

test("TypeScript 7.1 replies carry the same answers as value, missing and useOS", () => {
  const reply = (name: string, fs: Ts7FileSystem) =>
    JSON.parse(callback(name, fs, JSON.stringify("/file.ts"), true).text) as unknown;
  expect(reply("readFile", { ...fallback, readFile: () => "text" })).toEqual({
    kind: "value",
    value: "text",
  });
  expect(reply("readFile", { ...fallback, readFile: () => "" })).toEqual({
    kind: "value",
    value: "",
  });
  expect(reply("readFile", { ...fallback, readFile: () => null })).toEqual({ kind: "missing" });
  for (const name of TS7_FILE_SYSTEM_CALLBACKS.split(","))
    expect(reply(name, fallback), name).toEqual({ kind: "useOS" });
  expect(reply("fileExists", { ...fallback, fileExists: () => false })).toEqual({
    kind: "value",
    value: false,
  });
  expect(reply("realpath", { ...fallback, realpath: () => "/real.ts" })).toEqual({
    kind: "value",
    value: "/real.ts",
  });
  expect(
    reply("getAccessibleEntries", {
      ...fallback,
      getAccessibleEntries: () => ({ files: ["a.ts"], directories: [] }),
    }),
  ).toEqual({ kind: "value", value: { files: ["a.ts"], directories: [] } });
});

test("boolean false and empty directory entries do not fall through", () => {
  const fs = {
    ...fallback,
    fileExists: () => false,
    directoryExists: () => true,
    getAccessibleEntries: () => ({ files: [], directories: [] }),
  };
  expect(callback("fileExists", fs).text).toBe("false");
  expect(callback("directoryExists", fs).text).toBe("true");
  expect(JSON.parse(callback("getAccessibleEntries", fs).text)).toEqual({
    files: [],
    directories: [],
  });
});

test("paths and realpath replies preserve Unicode and quoting", () => {
  const path = '/a/"héllo 🌍"/file.ts';
  let seen = "";
  const reply = callback(
    "realpath",
    {
      ...fallback,
      realpath: (value) => {
        seen = value;
        return value + ".real";
      },
    },
    JSON.stringify(path),
  );
  expect(seen).toBe(path);
  expect(JSON.parse(reply.text)).toBe(path + ".real");
});

test.each(["null", "{}", "[]", "1", "true", "bad JSON"])(
  "invalid callback path %s fails the request",
  (payload) => {
    let called = false;
    const reply = callback(
      "readFile",
      {
        ...fallback,
        readFile: () => {
          called = true;
          return "";
        },
      },
      payload,
    );
    expect(called).toBe(false);
    expect(reply.kind).toBe(3);
    expect(reply.closed).toBe(true);
    expect(reply.error).toBeInstanceOf(Error);
  },
);
