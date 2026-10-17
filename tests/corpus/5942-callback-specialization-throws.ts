// Exceptions, `this` and argument evaluation order through helpers called
// with several callbacks: a throwing callback unwinds through the helper's
// finally blocks, and callbacks see `this` and their arguments as in Node.
function each(values: number[], f: (x: number) => void): number {
  let done = 0;
  try {
    for (const v of values) {
      f(v);
      done++;
    }
  } finally {
    console.log("each finished after", done);
  }
  return done;
}

function transform(values: number[], f: (x: number) => number): number[] {
  const out: number[] = [];
  for (const v of values) out.push(f(v));
  return out;
}

function receiver(f: (this: unknown, x: number) => string): string {
  return f(1);
}

function trace(label: string): number {
  console.log("arg", label);
  return label.length;
}

function main(): void {
  const log: string[] = [];
  console.log(each([1, 2, 3], (x) => log.push("a" + x)));
  try {
    each([1, 2, 3], (x) => {
      if (x === 2) throw new Error("stop at " + x);
      log.push("b" + x);
    });
  } catch (e) {
    console.log("caught", (e as Error).message);
  }
  try {
    each([4, 5], (x) => {
      throw new RangeError("range " + x);
    });
  } catch (e) {
    console.log("caught", e instanceof RangeError, (e as Error).message);
  }
  console.log(log.join(","));

  try {
    console.log(transform([1, 2, 3], (x) => x * 2).join(","));
    console.log(
      transform([1, 0, 3], (x) => {
        if (x === 0) throw new TypeError("zero");
        return 1 / x;
      }).join(","),
    );
  } catch (e) {
    console.log("caught", e instanceof TypeError, (e as Error).message);
  }
  console.log(transform([4, 9], Math.sqrt).join(","));

  console.log(
    receiver(function (this: unknown, x: number) {
      return typeof this + x;
    }),
  );
  console.log(receiver((x) => "arrow" + x));

  // Arguments are evaluated left to right before the helper runs.
  console.log(
    transform([trace("first"), trace("second!")], (x) => x + trace("cb")).join(","),
  );
  console.log(transform([trace("third")], (x) => -x).join(","));
}

main();
