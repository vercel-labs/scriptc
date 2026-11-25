// Every ArrayBufferView through the fs write paths: a view over
// WebAssembly memory at a nonzero offset, a subarray, a DataView window,
// typed arrays of other elements, a view over a shared buffer, and values
// whose type the call site does not pin down. Each write produces the
// bytes the view covers, and the async and descriptor forms take the same
// data.
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { appendFile, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "scr-write-views-"));
const path = join(directory, "data");

function hex(): string {
  return readFileSync(path).toString("hex");
}

// A function boundary erases the argument's static type, the shape a value
// from another module arrives in.
function opaque(value: unknown): any {
  return value;
}

async function main(): Promise<void> {
  // WebAssembly memory exports a plain ArrayBuffer; the view starts at an
  // offset inside it.
  const source = await WebAssembly.instantiate(
    Buffer.from("AGFzbQEAAAAFAwEAAQcKAQZtZW1vcnkCAA==", "base64"),
  );
  const exports = source.instance.exports;
  const memory = exports.memory as WebAssembly.Memory;
  const view = new Uint8Array(memory.buffer, 8, 6);
  view.set([0, 1, 2, 253, 254, 255]);
  writeFileSync(path, view);
  console.log("wasm", hex());

  // The same memory through a DataView and through a subarray of the view.
  writeFileSync(path, new DataView(memory.buffer, 9, 3));
  console.log("wasm dataview", hex());
  writeFileSync(path, view.subarray(2));
  console.log("wasm subarray", hex());

  // A subarray and a DataView window over an ordinary buffer.
  const backing = new Uint8Array([10, 11, 12, 13, 14, 15]);
  writeFileSync(path, backing.subarray(2, 5));
  console.log("subarray", hex());
  writeFileSync(path, new DataView(backing.buffer, 4, 2));
  console.log("dataview", hex());

  // Typed arrays of other elements carry their raw bytes.
  writeFileSync(path, new Uint16Array([0x0102, 0x0304, 0xffff]));
  console.log("uint16", hex());
  writeFileSync(path, new Uint16Array(backing.buffer, 2, 2));
  console.log("uint16 window", hex());
  writeFileSync(path, new Int8Array([-1, 0, 1]));
  console.log("int8", hex());
  writeFileSync(path, new Uint8ClampedArray([300]));
  console.log("clamped", hex());
  writeFileSync(path, new Float32Array([1]));
  console.log("float32", hex());
  writeFileSync(path, new Float64Array([-0]));
  console.log("float64", hex());

  // A view over a shared buffer.
  const shared = new Uint8Array(new SharedArrayBuffer(4));
  shared.set([9, 8, 7, 6]);
  writeFileSync(path, shared.subarray(1, 3));
  console.log("shared", hex());

  // Appending takes the same views.
  appendFileSync(path, new Uint16Array([0x0506]));
  console.log("append uint16", hex());
  appendFileSync(path, new DataView(backing.buffer, 0, 1), { flag: "a" });
  console.log("append dataview", hex());
  appendFileSync(path, backing.subarray(5), { encoding: "utf8" });
  console.log("append subarray", hex());

  // A value whose static type the call site does not pin down: the runtime
  // picks the string or view writer.
  writeFileSync(path, opaque(new Uint16Array([0x0102])));
  console.log("opaque uint16", hex());
  writeFileSync(path, opaque("hé"));
  console.log("opaque string", hex());
  appendFileSync(path, opaque(backing.subarray(0, 2)));
  console.log("opaque append", hex());
  appendFileSync(path, opaque("é"));
  console.log("opaque append string", hex());

  // The same data through the options records. A view keeps its bytes under
  // every encoding name, and the mode and flag apply as they do to strings.
  writeFileSync(path, opaque(new Uint16Array([0x0102])), { mode: 0o600 });
  console.log("mode", hex());
  writeFileSync(path, opaque(new Uint16Array([0x0102])), { flag: "w" });
  console.log("flag", hex());
  writeFileSync(path, opaque(backing.subarray(0, 3)), { encoding: "latin1" });
  console.log("record encoding", hex());
  writeFileSync(path, opaque(backing.subarray(0, 3)), "latin1");
  console.log("bare encoding", hex());
  appendFileSync(path, opaque(backing.subarray(0, 1)), "latin1");
  console.log("append encoding", hex());

  // The descriptor form writes the whole view and leaves the descriptor
  // open, so a second write continues after it.
  const descriptorPath = join(directory, "descriptor");
  const descriptor = openSync(descriptorPath, "w");
  writeFileSync(descriptor, opaque(new Uint16Array([0x0102])));
  writeFileSync(descriptor, "end");
  closeSync(descriptor);
  console.log("descriptor", readFileSync(descriptorPath).toString("hex"));

  // fs/promises and the FileHandle method.
  await writeFile(path, opaque(new Uint16Array([0x0304])));
  console.log("promise", hex());
  await appendFile(path, new DataView(backing.buffer, 1, 2));
  console.log("promise append", hex());
  const handle = await open(path, "r+");
  await handle.writeFile(opaque(backing.subarray(3, 5)));
  await handle.close();
  console.log("handle", hex());

  // A `string | Uint8Array` payload through the promise forms: the live arm
  // picks the writer.
  const payloads: (string | Uint8Array)[] = ["text ", new Uint8Array([0x62, 0x79, 0x74, 0x65])];
  for (const payload of payloads) {
    await writeFile(path, payload);
    await appendFile(path, payload);
  }
  console.log("promise union", hex());

  // Data Node refuses, reported before the path is touched.
  function refused(run: () => void): void {
    try {
      run();
      console.log("no throw");
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      console.log(e.name, e.code, e.message);
    }
  }
  const missing = join(directory, "missing");
  refused(() => writeFileSync(missing, 5 as any));
  refused(() => writeFileSync(missing, null as any));
  refused(() => writeFileSync(missing, undefined as any));
  refused(() => writeFileSync(missing, true as any));
  refused(() => appendFileSync(missing, {} as any));
  refused(() => appendFileSync(missing, [] as any));

  rmSync(directory, { recursive: true, force: true });
}

await main();
