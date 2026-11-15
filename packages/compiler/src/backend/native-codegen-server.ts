import {
  CODEGEN_SERVER_IDLE_EXIT,
  useNativeCodegenServer,
  type CodegenServerConnection,
  type CodegenServerResult,
} from "./codegen-server.js";

// Bound by native/codegen-process.ffi.json. This module is a native entry
// point: the Node host runs the helper as its own process (codegen-server.ts
// leaves its connection factory unset there).
declare function codegenNativeAttach(name: string, executable: string, idleExit: number): number;
declare function codegenNativeRead(
  handle: number,
  bytes: Uint8Array,
  offset: number,
  length: number,
): number;
declare function codegenNativeWrite(
  handle: number,
  bytes: Uint8Array,
  offset: number,
  length: number,
): number;
declare function codegenNativeClose(handle: number): void;
declare function codegenNativeError(bytes: Uint8Array): number;

/** A request's first line, shared with native/llvm-codegen/src/server.cpp. */
const PROTOCOL = "SCGEN1";

function nativeError(operation: string): Error {
  const bytes = new Uint8Array(512);
  const length = codegenNativeError(bytes);
  return new Error(
    `code generation server ${operation}: ${Buffer.from(bytes.subarray(0, length)).toString("utf8")}`,
  );
}

/** One request: the protocol, the argument count and the directory's byte
 * length, the directory, then each argument's byte length and bytes. */
function frameRequest(cwd: string, args: readonly string[]): Uint8Array {
  const directory = Buffer.from(cwd, "utf8");
  const encoded = args.map((arg) => Buffer.from(arg, "utf8"));
  const header = Buffer.from(`${PROTOCOL} ${encoded.length} ${directory.length}\n`, "utf8");
  let length = header.length + directory.length;
  for (const arg of encoded) length += String(arg.length).length + 1 + arg.length;
  const bytes = new Uint8Array(length);
  bytes.set(header, 0);
  bytes.set(directory, header.length);
  let at = header.length + directory.length;
  for (const arg of encoded) {
    const size = Buffer.from(`${arg.length}\n`, "utf8");
    bytes.set(size, at);
    at += size.length;
    bytes.set(arg, at);
    at += arg.length;
  }
  return bytes;
}

/** A connection to a resident code generation server: one request at a time,
 * each answered with its exit code and captured output. */
class NativeCodegenServer implements CodegenServerConnection {
  private handle: number;
  /** Bytes the last read brought in beyond the response they answered. */
  private buffered = new Uint8Array(0);
  private at = 0;

  constructor(handle: number) {
    this.handle = handle;
  }

  private send(bytes: Uint8Array): void {
    for (let at = 0; at < bytes.length;) {
      const count = codegenNativeWrite(this.handle, bytes, at, bytes.length - at);
      if (count === 0) throw new Error("code generation server closed the connection");
      if (count < 0) throw nativeError("write");
      at += count;
    }
  }

  /** Reads what the response needs; the server sends nothing else. */
  private receive(): void {
    const incoming = new Uint8Array(8192);
    const count = codegenNativeRead(this.handle, incoming, 0, incoming.length);
    if (count === 0) throw new Error("code generation server closed the connection");
    if (count < 0) throw nativeError("read");
    const kept = this.buffered.length - this.at;
    const buffered = new Uint8Array(kept + count);
    buffered.set(this.buffered.subarray(this.at, this.buffered.length), 0);
    buffered.set(incoming.subarray(0, count), kept);
    this.buffered = buffered;
    this.at = 0;
  }

  private line(): string {
    for (;;) {
      for (let index = this.at; index < this.buffered.length; index++) {
        if (this.buffered[index] === 0x0a) {
          const text = Buffer.from(this.buffered.subarray(this.at, index)).toString("utf8");
          this.at = index + 1;
          return text;
        }
      }
      this.receive();
    }
  }

  private text(length: number): string {
    while (this.buffered.length - this.at < length) this.receive();
    const text = Buffer.from(this.buffered.subarray(this.at, this.at + length)).toString("utf8");
    this.at += length;
    return text;
  }

  run(cwd: string, args: readonly string[]): CodegenServerResult {
    this.send(frameRequest(cwd, args));
    const header = this.line();
    const fields = header.split(" ");
    if (fields.length !== 4 || fields[0] !== PROTOCOL)
      throw new Error(`code generation server sent an unreadable response: ${header}`);
    const status = Number(fields[1]);
    const stdout = this.text(Number(fields[2]));
    const stderr = this.text(Number(fields[3]));
    // A response ends the request, and the next one starts clean.
    this.buffered = new Uint8Array(0);
    this.at = 0;
    return { status, stdout, stderr };
  }

  close = (): void => {
    if (this.handle === 0) return;
    const handle = this.handle;
    this.handle = 0;
    codegenNativeClose(handle);
  };
}

useNativeCodegenServer((name, executable) => {
  const handle = codegenNativeAttach(name, executable, CODEGEN_SERVER_IDLE_EXIT);
  return handle === 0 ? null : new NativeCodegenServer(handle);
});
