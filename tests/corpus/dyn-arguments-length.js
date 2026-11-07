// `arguments` in a closure a checked-dynamic call reaches: the count must be
// the number of arguments the caller passed, not the declared arity. The
// closure declares 3 parameters and every path calls it with 0 to 4 of them,
// directly and through a value, a record field, call/apply, an EventEmitter
// listener and a process.stdout.write replacement.
import { EventEmitter } from "node:events";

function declared(a, b, c) {
  return `n=${arguments.length} ${typeof a}/${typeof b}/${typeof c} a3=${typeof arguments[3]}`;
}
const expressed = function (a, b, c) {
  return `n=${arguments.length} ${typeof a}/${typeof b}/${typeof c} a3=${typeof arguments[3]}`;
};
/** @type {any} */
const anyDeclared = declared;
/** @type {any} */
const anyExpressed = expressed;
const record = { declared, expressed };
/** @type {any} */
const dynRecord = record;

const calls = [
  ["0", []],
  ["1", ["a"]],
  ["2", ["a", "b"]],
  ["3", ["a", "b", "c"]],
  ["4", ["a", "b", "c", "d"]],
];
for (const [label, args] of calls) {
  console.log("direct-declared", label, declared(...args));
  console.log("direct-expressed", label, expressed(...args));
  console.log("any-declared", label, anyDeclared(...args));
  console.log("any-expressed", label, anyExpressed(...args));
  console.log("record", label, dynRecord.declared(...args), "|", dynRecord.expressed(...args));
}

// `call`/`apply` with a spread argument list want the callee's signature
// across the checked-value boundary, which a closure reading `arguments`
// cannot (a loud SC1090 refusal): spell the arguments out.
console.log("call 0", declared.call(null));
console.log("call 1", declared.call(null, "a"));
console.log("call 2", declared.call(null, "a", "b"));
console.log("call 3", declared.call(null, "a", "b", "c"));
console.log("call 4", declared.call(null, "a", "b", "c", "d"));
console.log("apply 0", expressed.apply(null, []));
console.log("apply 1", expressed.apply(null, ["a"]));
console.log("apply 2", expressed.apply(null, ["a", "b"]));
console.log("apply 3", expressed.apply(null, ["a", "b", "c"]));
console.log("apply 4", expressed.apply(null, ["a", "b", "c", "d"]));

// A listener receives the arguments the emit call passed.
const heard = [];
function listener(a, b, c) {
  heard.push(`n=${arguments.length} ${typeof a}/${typeof b}/${typeof c}`);
}
const emitter = new EventEmitter();
emitter.on("x", listener);
// A spread into `emit` is a loud SC1090 refusal (a runtime argument list):
// pass the arguments one by one.
emitter.emit("x");
console.log("emit 0", heard.pop());
emitter.emit("x", "a");
console.log("emit 1", heard.pop());
emitter.emit("x", "a", "b");
console.log("emit 2", heard.pop());
emitter.emit("x", "a", "b", "c");
console.log("emit 3", heard.pop());
emitter.emit("x", "a", "b", "c", "d");
console.log("emit 4", heard.pop());

// A replaced stdout.write is called by the runtime with the call's own
// arguments: a direct write passes what it was given.
const originalWrite = process.stdout.write;
const seen = [];
process.stdout.write = function (chunk, encodingOrCallback, callback) {
  seen.push(
    `write n=${arguments.length} ${typeof chunk}/${typeof encodingOrCallback}/${typeof callback}`,
  );
  return true;
};
process.stdout.write("one");
process.stdout.write("two", "utf8");
process.stdout.write = originalWrite;
console.log(seen.join("\n"));

// The same replacement reading elements past the passed count.
const widened = [];
process.stdout.write = function (a, b, c) {
  widened.push(`n=${arguments.length} a=${String(a)} b=${String(b)} c=${String(c)}`);
  return true;
};
process.stdout.write("only");
process.stdout.write("a", "b");
process.stdout.write = originalWrite;
console.log(widened.join("\n"));
