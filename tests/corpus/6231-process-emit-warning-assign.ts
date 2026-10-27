// process.emitWarning and process.title are ordinary writable properties
// (pi's CLI setup assigns both). After the replacement, process.emitWarning
// calls reach it with their own arguments, no report reaches stderr, and
// the warnings Node's own modules emit through process.emitWarning (a
// util.deprecate wrapper's first call) reach it too.
import { deprecate } from "node:util";

process.title = "pi";
console.log("title", process.title);
process.env.PI_CODING_AGENT = "true";
console.log("env", process.env.PI_CODING_AGENT);

const seen: string[] = [];
process.on("warning", (w) => seen.push(`listener ${w.name}`));
function show(a: unknown): string {
  if (a instanceof Error) return `Error(${a.message})`;
  return typeof a === "object" ? JSON.stringify(a) : String(a);
}
process.emitWarning = ((warning: unknown, type: unknown, code: unknown) => {
  seen.push(`${show(warning)}|${show(type)}|${show(code)}`);
}) as typeof process.emitWarning;

process.emitWarning("plain");
process.emitWarning("typed", "CustomWarning", "CW_1");
process.emitWarning("options", { type: "OptWarning", code: "OW_1", detail: "d" });
process.emitWarning(new Error("as error"));
const old = deprecate(() => "result", "old() is deprecated", "DEP_SCRIPTC_1");
console.log("deprecated call", old());
console.log("second call", old());
console.log("sync", seen.join(" ; "));

// A replacement that does nothing silences warnings entirely.
process.emitWarning = (() => {}) as typeof process.emitWarning;
process.emitWarning("silenced");
setTimeout(() => console.log("after tick", seen.length), 0);
