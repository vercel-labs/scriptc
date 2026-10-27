// The deprecated `new Buffer(...)` in TypeScript, over the forms
// @types/node declares: strings with an encoding, sizes, arrays and
// ArrayBuffers. The first call reports DEP0005 on the next tick.
// The program re-runs itself and prints the child's output with process
// ids normalized.
import { spawnSync } from "node:child_process";

function child(): void {
  process.on("warning", (w) => console.log("listener", w.name, (w as { code?: string }).code));

  function sized(n: number): Buffer {
    return new Buffer(n);
  }

  const encodings: BufferEncoding[] = ["utf8", "hex", "base64", "latin1"];
  for (const encoding of encodings) {
    console.log(encoding, new Buffer("6869", encoding));
  }
  console.log(sized(3), sized(0).length);
  console.log(new Buffer([104, 105]).toString(), new Buffer(new Uint8Array([1, 2])));
  const storage = new ArrayBuffer(4);
  const view = new Buffer(storage);
  view[1] = 5;
  console.log(new Uint8Array(storage), view.buffer === storage);
  const text: string = "typed";
  console.log(new Buffer(text).toString("hex"));
  try {
    sized(-2);
  } catch (e) {
    console.log((e as Error).name, (e as { code?: string }).code);
  }
  console.log("sync end");
}

if (process.argv[2] === "child") {
  child();
} else {
  const run = spawnSync(process.execPath, [process.argv[1]!, "child"], { encoding: "utf8" });
  console.log(`status: ${run.status}`);
  console.log(run.stdout);
  console.log(run.stderr.replace(/\(node:\d+\)/g, "(node:<pid>)"));
}
