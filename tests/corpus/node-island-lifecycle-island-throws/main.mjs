// @requires-libnode
// Everything island code can throw or reject with, observed by native code:
// name, message, stack, cause, instanceof against built-ins and the island's
// own classes, custom properties, methods, and non-Error values, thrown
// synchronously, rejected, rejected later and thrown by an async function.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

function describe(e) {
  if (e === null || (typeof e !== "object" && typeof e !== "function")) return `${typeof e} ${String(e)}`;
  if (!(e instanceof Error)) return `non-error ${Array.isArray(e) ? `array ${e.length} ${e[1]}` : `object ${e.message} ${e.code}`}`;
  const parts = [
    `name=${e.name}`,
    `message=${JSON.stringify(e.message)}`,
    `ctor=${e.constructor.name}`,
    `str=${String(e)}`,
    `stack=${typeof e.stack}:${String(e.stack).split("\n")[0]}`,
    `is=${[Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError, AggregateError].filter((C) => e instanceof C).map((C) => C.name).join("+")}`,
    `island=${e instanceof lib.IslandError}/${e instanceof lib.Deep}`,
  ];
  if (e.code !== undefined) parts.push(`code=${e.code}`);
  if (e.errno !== undefined) parts.push(`errno=${typeof e.errno}`);
  if (e.syscall !== undefined) parts.push(`syscall=${e.syscall}`);
  if (e.extra !== undefined) parts.push(`extra=${typeof e.extra}:${e.extra.k ?? e.extra[1]}`);
  const method = e.describe;
  if (typeof method === "function") parts.push(`method=${method.call(e)}`);
  if (e.cause !== undefined) parts.push(`cause=[${describe(e.cause)}]`);
  if (e.errors !== undefined) parts.push(`errors=[${e.errors.map(describe).join("; ")}]`);
  return parts.join(" ");
}

async function main() {
  const kinds = lib.kinds.filter((kind) => kind !== "array" && kind !== "aggregate");
  for (const kind of kinds) {
    try {
      lib.throwSync(kind);
      log(`${kind}: did not throw`);
    } catch (e) {
      log(`sync ${kind}: ${describe(e)}`);
    }
  }
  for (const kind of kinds) {
    for (const how of ["reject", "rejectLater", "asyncThrow"]) {
      try {
        await lib[how](kind);
        log(`${kind}: did not reject`);
      } catch (e) {
        log(`${how} ${kind}: ${describe(e)}`);
      }
    }
  }
  // .catch and the second argument of .then see the same values.
  await lib.reject("custom").catch((e) => log(`catch: ${e.name} ${e.extra.k}`));
  await lib.reject("string").then(null, (e) => log(`then reject handler: ${e}`));
}

main();
