// @requires-libnode
// A process.stdout.write replacement installed by island code sees the
// program's native output, and either side can restore the stream or stack
// its own replacement on the other's: the saved previous method is called
// from the other side with the stream as its receiver, and a replacement
// that writes through the method it replaced does not call itself.
import { callSync } from "@scriptc/node";

type Write = typeof process.stdout.write;
const rawStdout = process.stdout.write.bind(process.stdout) as (chunk: string) => boolean;
const rawStderr = process.stderr.write.bind(process.stderr) as (chunk: string) => boolean;
const original = process.stdout.write;

function text(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
}

// 1. The island installs a replacement: native output reaches it.
callSync("./capture.cjs", "install", "A");
console.log("native log");
process.stdout.write("native string\n");
process.stdout.write(Buffer.from("native buffer\n"));
process.stdout.write("6e617469766520686578210a", "hex");
process.stdout.write("native callback\n", (error) => {
  rawStderr(`native callback ran: ${error === null}\n`);
});
const accepted = process.stdout.write("native result\n");
// Chunks whose type is known only at run time take the same route.
const untyped: any = JSON.parse('"native untyped string\\n"');
const untypedBytes: any = Buffer.from("native untyped buffer\n");
const either: string | Uint8Array = accepted ? "native union string\n" : new Uint8Array(0);
process.stdout.write(untyped);
process.stdout.write(untypedBytes);
process.stdout.write(either);
rawStderr(`accepted ${accepted}, replaced ${process.stdout.write !== original}\n`);

// 2. Native code restores the stream the island replaced.
process.stdout.write = original;
console.log("restored by native code", process.stdout.write === original);
console.log(callSync<string>("./capture.cjs", "state"));

// 3. The island installs again and restores what it saved.
callSync("./capture.cjs", "install", "B");
console.log("captured again");
callSync("./capture.cjs", "restore");
console.log("restored by the island", process.stdout.write === original);

// 4. Native code replaces the stream, the island stacks its replacement on
// top and calls the native one through the method it saved.
const native = ((chunk: string | Uint8Array): boolean =>
  rawStdout(`[native] ${text(chunk)}`)) as Write;
process.stdout.write = native;
callSync("./capture.cjs", "install", "C");
console.log("through both");
callSync("./capture.cjs", "write", "island write through both\n");
callSync("./capture.cjs", "restore");
console.log("native replacement again", process.stdout.write === native);
process.stdout.write = original;

// 5. A replacement that throws: the error reaches the writer on the other
// side as itself.
process.stdout.write = ((chunk: string | Uint8Array): boolean => {
  throw new RangeError(`native refuses ${text(chunk).trimEnd()}`);
}) as Write;
const islandCaught = callSync<string>("./capture.cjs", "attempt", "an island write\n");
process.stdout.write = original;
callSync("./capture.cjs", "refuse");
let nativeCaught = "";
try {
  process.stdout.write("a native write\n");
} catch (e) {
  nativeCaught = `${e instanceof TypeError} ${(e as Error).message}`;
}
callSync("./capture.cjs", "restore");
console.log(islandCaught);
console.log(nativeCaught);

// 6. From a promise reaction and from a timer the replacement is still the
// island's.
callSync("./capture.cjs", "install", "D");
async function later(): Promise<void> {
  await Promise.resolve();
  console.log("after an await");
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  process.stdout.write("after a timer\n");
  callSync("./capture.cjs", "restore");
  console.log(callSync<string>("./capture.cjs", "seen"));
}
void later();
