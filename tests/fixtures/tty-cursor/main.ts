/* The escape sequences tty.WriteStream's cursor methods write, with a
 * completion callback and the zero-delta moveCursor no-op. */
process.stdout.cursorTo(2, 3);
process.stdout.moveCursor(-1, 2);
process.stdout.clearLine(0);
process.stdout.clearScreenDown();
process.stdout.cursorTo(0);
process.stdout.cursorTo(5, 5, () => {
  process.stdout.write("CALLBACK\n");
});
process.stdout.cursorTo(1, () => {
  process.stdout.write("SHORT CALLBACK\n");
});
process.stdout.moveCursor(0, 0, () => {
  process.stdout.write("ZERO CALLBACK\n");
});
process.stdout.clearLine(-1);
/* A NaN coordinate is the method's own argument check, run on a terminal
 * before anything is written; the completion callback never runs there. */
function nanOutcome(name: string, f: () => void): void {
  try {
    f();
    process.stdout.write(name + " pass\n");
  } catch (e) {
    process.stdout.write(
      name + " " + String(e instanceof TypeError) + " " +
        (e instanceof Error ? e.message : "not an Error") + "\n",
    );
  }
}
nanOutcome("NANX", () => process.stdout.cursorTo(NaN));
nanOutcome("NANY", () => process.stdout.cursorTo(0, NaN));
nanOutcome("NANCB", () =>
  process.stdout.cursorTo(NaN, () => {
    process.stdout.write("NAN CALLBACK\n");
  }));
/* A replaced write owns the completion: it receives the cursor method's
 * callback, and the callback fires only when the replacement calls it. */
const origWrite = process.stdout.write;
let swallowed = "";
let completed = "";
const swallowCallback: any = function (chunk: string, ...rest: any[]): boolean {
  swallowed = String(chunk).length + ":" + typeof rest[rest.length - 1];
  return true;
};
process.stdout.write = swallowCallback;
process.stdout.cursorTo(3, 4, () => {
  swallowed += "/fired";
});
const completeCallback: any = function (chunk: string, ...rest: any[]): boolean {
  completed = String(chunk).length + ":" + typeof rest[rest.length - 1];
  const cb = rest[rest.length - 1];
  if (typeof cb === "function") cb();
  return true;
};
process.stdout.write = completeCallback;
process.stdout.clearLine(0, () => {
  completed += "/fired";
});
process.stdout.write = origWrite;
process.stdout.write("REPLACED " + swallowed + " " + completed + "\n");
process.stdout.write("DONE\n");
