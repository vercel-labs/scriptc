// @requires-libnode
// Output written just before the process ends is not lost when it goes
// through a replaced process.stdout.write: island lines written in a timer
// right before process.exit, and the 'exit' listeners of both sides.
import { callSync } from "@scriptc/node";

const rawStderr = process.stderr.write.bind(process.stderr) as (chunk: string) => boolean;
process.stdout.write = ((chunk: string | Uint8Array): boolean =>
  rawStderr(`[guard] ${typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)}`)) as typeof process.stdout.write;

process.on("exit", (code) => {
  console.log("native exit listener", code);
  process.stdout.write("native last write\n");
});
callSync("./leave.cjs", "arm", 5);
console.log("armed");
