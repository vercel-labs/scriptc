// JSON.stringify answers undefined, not the text "undefined", for a root
// that is undefined, a function or a symbol. An untyped root decides that
// at run time, so the result keeps the value wherever the program can tell
// the two apart.
function describe(root: unknown): string {
  const text = JSON.stringify(root);
  return `${typeof text} ${text === undefined} ${text ?? "none"} ${text}`;
}
const roots: unknown[] = [undefined, () => 1, Symbol("s"), null, 0, "", [undefined], { a: undefined }];
for (const root of roots) console.log(describe(root));

function collect(): void {
  const u: unknown = undefined;
  const kept = JSON.stringify(u);
  const list = [kept, "x"];
  console.log(list.join("|"), list.length, list[0] === undefined);
  console.log([JSON.stringify(u)].join("|") === "", [JSON.stringify(u)].length);
  console.log(JSON.stringify(u, null, 2) === undefined, typeof JSON.stringify(u, null, 2));
  const fn: unknown = function named(): number {
    return 1;
  };
  const fromFunction = JSON.stringify(fn);
  console.log(typeof fromFunction, fromFunction === undefined, String(fromFunction));
  const symbol: unknown = Symbol("t");
  const compared = JSON.stringify(symbol);
  console.log(typeof compared, compared === undefined, [compared].join("|") === "");
}
collect();

// Uses that read undefined and the text alike.
const shown: unknown = undefined;
const printed = JSON.stringify(shown);
console.log(printed);
console.log("value: " + printed, `${printed}`, String(JSON.stringify(shown)), JSON.stringify(shown) + "!");

// A module-level binding the program compares, and a helper that returns
// the result.
const compared = JSON.stringify(shown);
console.log(typeof compared, compared === undefined, [compared].join("|") === "");
function serialize(value: unknown) {
  return JSON.stringify(value);
}
const viaHelper = serialize(undefined);
console.log(typeof viaHelper, viaHelper === undefined, serialize(1), serialize("x"));

// A class whose toJSON answers undefined serializes to undefined as well,
// through a helper with an inferred result too.
class Quiet {
  toJSON(): unknown {
    return undefined;
  }
}
class Tagged {
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  toJSON(): unknown {
    return { tag: this.tag };
  }
}
function serializeQuiet(value: Quiet) {
  return JSON.stringify(value);
}
function serializeTagged(value: Tagged) {
  return JSON.stringify(value);
}
const quiet = serializeQuiet(new Quiet());
console.log(typeof quiet, quiet === undefined, serializeTagged(new Tagged("t")));
