// Duplex.from over an async function: a Duplex that is only writable, whose
// writes reach the function's source and whose end waits for the
// function's promise. A value other than null or undefined is
// ERR_INVALID_RETURN_VALUE, a return before the input is consumed aborts
// the Duplex, and a throw destroys it.
import { Duplex } from "node:stream";
const log = [];
const sink = Duplex.from(async function (source) {
  for await (const c of source) log.push(`sink got ${c}`);
  log.push("sink done");
});
log.push(`sink ${sink.readable} ${sink.writable} ${sink.writableObjectMode}`);
sink.on("finish", () => log.push("sink finish"));
sink.on("close", () => log.push("sink close"));
sink.write("a", () => log.push("cb a"));
sink.end("b", () => log.push("end cb"));
await new Promise((res) => sink.on("close", res));
const bad = Duplex.from(async function (source) {
  for await (const c of source) log.push(`bad got ${c}`);
  return 5;
});
bad.on("error", (e) => log.push(`bad error ${e.code} ${e.message}`));
bad.on("close", () => log.push("bad close"));
bad.end("x");
await new Promise((res) => bad.on("close", res));
const early = Duplex.from(async function (source) {
  for await (const c of source) { log.push(`early got ${c}`); break; }
});
early.on("error", (e) => log.push(`early error ${e.name}`));
early.on("close", () => log.push(`early close ${early.destroyed}`));
early.write("1");
early.write("2");
await new Promise((res) => early.on("close", res));
const failing = Duplex.from(async function (source) {
  for await (const c of source) throw new Error("fail " + c);
});
failing.on("error", (e) => log.push(`failing error ${e.message}`));
failing.write("z");
await new Promise((res) => failing.on("close", res));
console.log(log.join("\n"));
