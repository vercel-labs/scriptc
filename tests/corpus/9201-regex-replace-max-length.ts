// A regular-expression substitution whose result passes Node's maximum
// string length throws its catchable RangeError. One quarter of the work is
// shared: the replacement is exactly the limit in code units, so any subject
// text around it pushes the result past it.
function check(label: string, build: () => string): void {
  try {
    const built = build();
    console.log(label, "built", built.length);
  } catch (error) {
    const e = error as Error;
    console.log(label, e.name, e.message);
  }
}

const big = "x".repeat(536870888);
console.log(big.length);
check("replace", () => "baac".replace(/a+/, big));
check("replaceAll", () => "baac".replaceAll(/a+/g, big));
// The anchored and global forms take the runtime's own replace loop.
check("anchored", () => big.replace(/^a/, "ab"));
check("anchored-global", () => big.replace(/^a/g, "ab"));
check("anchored-all", () => big.replaceAll(/^a/g, "ab"));
console.log("small", "naan".replace(/a+/g, "X"));
