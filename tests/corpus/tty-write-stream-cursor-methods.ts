// tty.WriteStream's cursor methods in a typed program: the escape sequence
// each writes goes through the stream, and a descriptor that is no terminal
// has none of them — Node's TypeError names the call.
function outcome(name: string, f: () => void): void {
  try {
    f();
    console.log(name, "pass");
  } catch (e) {
    console.log(name, e instanceof TypeError, e instanceof Error ? e.message : "not an Error");
  }
}

outcome("cursor", () => process.stdout.cursorTo(0, 0));
outcome("move", () => process.stdout.moveCursor(1, -1));
outcome("clear", () => process.stdout.clearLine(0));
outcome("clearScreen", () => process.stdout.clearScreenDown());
outcome("cursorWithCallback", () => process.stdout.cursorTo(1, () => {}));
console.log("optional calls", process.stdout.clearLine?.(0) === undefined,
  process.stdout.cursorTo?.(1, () => {}) === undefined);
function argA(): number {
  console.log("argA evaluated");
  return 0;
}
function argB(): number {
  console.log("argB evaluated");
  return 0;
}
try {
  process.stdout.clearLine(argA());
} catch (e) {
  console.log("plain", e instanceof TypeError, (e as Error).message);
}
process.stdout.clearLine?.(argB());
console.log("optional arg skipped");
/* The NaN checks belong to the method a terminal provides: on a pipe the
 * call throws the missing-method TypeError (the argument itself is fine),
 * and an optional call skips it without validating anything. */
function argNaN(): number {
  console.log("argNaN evaluated");
  return NaN;
}
try {
  process.stdout.cursorTo(argNaN());
} catch (e) {
  console.log("nan", e instanceof TypeError, (e as Error).message);
}
process.stdout.cursorTo?.(argNaN());
console.log("optional nan skipped");
