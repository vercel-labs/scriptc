import { expect, test, vi } from "vitest";
import {
  codegenServerName,
  runOnCodegenServer,
  useNativeCodegenServer,
  type CodegenServerConnection,
  type CodegenServerResult,
} from "./codegen-server.js";

const hasSockets = process.platform === "linux" || process.platform === "darwin";

// Every test names its own server, because a build remembers its connection.
let servers = 0;
const freshName = () => `server-${servers++}`;

const result: CodegenServerResult = { status: 0, stdout: "ok", stderr: "" };

test("a build on a platform without sockets leaves the server off", () => {
  const name = codegenServerName(process.execPath, "0.4.7", "x86_64-linux-gnu", {});
  if (hasSockets) expect(name).toMatch(/^[0-9a-f]{32}$/);
  else expect(name).toBe(null);
});

test("SCRIPTC_CODEGEN_SERVER=0 leaves the server off", () => {
  expect(
    codegenServerName(process.execPath, "0.4.7", "x86_64-linux-gnu", {
      SCRIPTC_CODEGEN_SERVER: "0",
    }),
  ).toBe(null);
});

test("CI leaves the server off unless a build turns it on", () => {
  expect(codegenServerName(process.execPath, "0.4.7", "x86_64-linux-gnu", { CI: "1" })).toBe(null);
  const name = codegenServerName(process.execPath, "0.4.7", "x86_64-linux-gnu", {
    CI: "1",
    SCRIPTC_CODEGEN_SERVER: "1",
  });
  if (hasSockets) expect(name).toMatch(/^[0-9a-f]{32}$/);
  else expect(name).toBe(null);
});

test("the name covers the helper, the compiler, the package version and the target", () => {
  const name = (helper: string, version: string, target: string) =>
    codegenServerName(helper, version, target, {});
  const base = name(process.execPath, "0.4.7", "x86_64-linux-gnu");
  expect(name(process.execPath, "0.4.7", "x86_64-linux-gnu")).toBe(base);
  if (base === null) return;
  expect(hasSockets).toBe(true);
  expect(base).toMatch(/^[0-9a-f]{32}$/);
  expect(name(process.execPath, "0.4.8", "x86_64-linux-gnu")).not.toBe(base);
  expect(name(process.execPath, "0.4.7", "aarch64-linux-gnu")).not.toBe(base);
  expect(name(import.meta.filename, "0.4.7", "x86_64-linux-gnu")).not.toBe(base);
});

test("an unreadable helper leaves the build to its own processes", () => {
  expect(
    codegenServerName("/nonexistent/scriptc-llvm-codegen", "0.4.7", "x86_64-linux-gnu", {}),
  ).toBe(null);
});

test("a build whose connector answers nothing runs its commands itself", () => {
  useNativeCodegenServer(() => null);
  expect(runOnCodegenServer(freshName(), process.execPath, "/work", ["emit"])).toBe(null);
});

test("one connection serves every command of a build", () => {
  const run = vi.fn(() => result);
  const close = vi.fn();
  const connect = vi.fn((): CodegenServerConnection => ({ run, close }));
  useNativeCodegenServer(connect);
  const name = freshName();
  expect(runOnCodegenServer(name, process.execPath, "/work", ["version"])).toEqual(result);
  expect(runOnCodegenServer(name, process.execPath, "/work", ["emit"])).toEqual(result);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(connect).toHaveBeenCalledWith(name, process.execPath);
  expect(run).toHaveBeenLastCalledWith("/work", ["emit"]);
  expect(close).not.toHaveBeenCalled();
});

test("each server name has its own connection", () => {
  const connect = vi.fn((_name: string, _executable: string): CodegenServerConnection => ({
    run: () => result,
    close: () => {},
  }));
  useNativeCodegenServer(connect);
  const first = freshName();
  const second = freshName();
  runOnCodegenServer(first, process.execPath, "/work", ["emit"]);
  runOnCodegenServer(second, process.execPath, "/work", ["emit"]);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(connect.mock.calls.map(([name]) => name)).toEqual([first, second]);
});

test("a server that fails is closed and the build runs its commands itself", () => {
  const close = vi.fn();
  const connect = vi.fn((): CodegenServerConnection => {
    return {
      run: () => {
        throw new Error("closed");
      },
      close,
    };
  });
  useNativeCodegenServer(connect);
  const name = freshName();
  expect(runOnCodegenServer(name, process.execPath, "/work", ["emit"])).toBe(null);
  expect(close).toHaveBeenCalledTimes(1);
  expect(runOnCodegenServer(name, process.execPath, "/work", ["emit"])).toBe(null);
  expect(connect).toHaveBeenCalledTimes(1);
});

test("a connection that cannot be opened leaves the build to its own processes", () => {
  const connect = vi.fn((): CodegenServerConnection | null => {
    throw new Error("no socket");
  });
  useNativeCodegenServer(connect);
  const name = freshName();
  expect(runOnCodegenServer(name, process.execPath, "/work", ["emit"])).toBe(null);
  expect(runOnCodegenServer(name, process.execPath, "/work", ["emit"])).toBe(null);
  expect(connect).toHaveBeenCalledTimes(1);
});
