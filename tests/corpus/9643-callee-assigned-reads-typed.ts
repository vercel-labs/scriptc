// A typed binding or property is assigned `undefined` (or `null`), a
// function called afterwards assigns it a value, and it is read. TypeScript
// keeps the type of the last assignment in the read's own function across
// the call, so it types the read `undefined`. The read is the stored value:
// a library function with an optional parameter gets it, not "absent".

function show(value: unknown): string {
  return typeof value + " " + String(value);
}

// A module-level binding and a closure.
let start: number | undefined = undefined;
let filler: string | undefined = undefined;
let label: string | null = null;
const fill = (): void => {
  start = 2;
  filler = "-";
  label = "named";
};
fill();
console.log("strings:", "abcdef".slice(start), "abab".indexOf("b", start), "x".padStart(3, filler));
console.log("arrays:", [1, 2, 3, 4].slice(start).join(), [1, 2].join(filler), [5, 6, 7].includes(7, start));
console.log("numbers:", Number(start), parseInt("11", start), (5).toString(start), (1.2345).toFixed(start));
console.log("json:", JSON.stringify({ a: 1 }, null, start), JSON.stringify({ a: 1 }, null, filler));
console.log("values:", show(start), show(filler), show(label), String(start), `${filler}${start}`);
console.log("tests:", start === undefined, filler ?? "absent", label || "empty", start ? "set" : "unset", typeof label);
console.log("parenthesized:", "abcdef".slice((start)), [1, 2].join((filler)));
console.log("ends:", "abcdef".slice(1, start), [1, 2, 3, 4].slice(1, start).join(), [1, 2, 1].indexOf(1, start));
console.log("more:", "abab".startsWith("ab", start), (1.5).toExponential(start), [1, 2, 3, 4].fill(0, start).join());
const copy = start;
const fillerCopy = filler;
console.log("copies:", "abcdef".slice(copy), [1, 2].join(fillerCopy), show(copy), show(fillerCopy));

// Locals of a function, assigned by the callback of a library function.
function widest(words: string[]): string {
  let width: number | undefined = undefined;
  let pad: string | undefined = undefined;
  words.forEach((word) => {
    if (width === undefined || word.length > width) width = word.length;
    pad = word[0];
  });
  return words.map((word) => word.padStart(width ?? 0, pad)).join("|") + " " + "0123456789".slice(width);
}
console.log("widest:", widest(["a", "bcd", "ef"]), "/", widest([]));

// A parameter set to undefined and assigned by a nested function.
function reset(from?: number, mark?: string): string {
  from = undefined;
  mark = undefined;
  function restore(): void {
    from = 1;
    mark = "*";
  }
  restore();
  return "abcd".slice(from) + " " + "x".padEnd(3, mark) + " " + show(from);
}
console.log("parameter:", reset(3, "?"));

// Class fields cleared in a method and refilled by another method, a
// function and a closure.
class Cursor {
  offset: number | undefined = undefined;
  mark: string | undefined = undefined;
  refill(): void {
    this.offset = 3;
    this.mark = "#";
  }
  viaMethod(): string {
    this.offset = undefined;
    this.mark = undefined;
    this.refill();
    return "abcdef".slice(this.offset) + " " + [1, 2].join(this.mark) + " " + show(this.offset);
  }
  viaFunction(): string {
    this.offset = undefined;
    this.mark = undefined;
    refillCursor(this);
    return "abcdef".slice(this.offset) + " " + [1, 2].join(this.mark) + " " + Number(this.offset);
  }
  viaClosure(): string {
    this.offset = undefined;
    const set = (): void => {
      this.offset = 1;
    };
    set();
    return "abcdef".slice(this.offset) + " " + "abab".indexOf("b", this.offset);
  }
}
function refillCursor(cursor: Cursor): void {
  cursor.offset = 4;
  cursor.mark = "+";
}
const cursor = new Cursor();
console.log("fields:", cursor.viaMethod(), "/", cursor.viaFunction(), "/", cursor.viaClosure());

// An object's properties.
const options: { indent: number | undefined; separator: string | undefined } = {
  indent: undefined,
  separator: undefined,
};
function choose(): void {
  options.indent = 1;
  options.separator = ":";
}
function formatted(): string {
  options.indent = undefined;
  options.separator = undefined;
  choose();
  return JSON.stringify([1], null, options.indent) + " " + ["a", "b"].join(options.separator);
}
console.log("properties:", formatted());

// A declared return type carries the stored value; so do a typed binding,
// a collection and a thrown value.
function found(items: string[], wanted: string): string | undefined {
  let match: string | undefined = undefined;
  items.forEach((item) => {
    if (item.startsWith(wanted)) match = item;
  });
  return match;
}
function kept(): string {
  let value: string | undefined = undefined;
  const set = (): void => {
    value = "kept";
  };
  set();
  const typed: string | undefined = value;
  const list: unknown[] = [];
  list.push(value);
  const map = new Map<string, unknown>();
  map.set("key", value);
  let caught: unknown = "nothing";
  try {
    throw value;
  } catch (thrown) {
    caught = thrown;
  }
  return [show(typed), show(list[0]), show(map.get("key")), show(caught)].join(" | ");
}
console.log("returned:", show(found(["apple", "banana"], "b")), "/", show(found(["apple"], "b")));
console.log("kept:", kept());

// An untyped copy that is assigned `undefined` afterwards holds that: the
// assignment ends what the initializer left in it, and a function that
// returns the reset copy returns nothing, as TypeScript infers.
function resetCopy(): string {
  let from: number | undefined = undefined;
  const set = (): void => {
    from = 2;
  };
  set();
  let copy = from;
  const kept = "abcd".slice(copy);
  copy = undefined;
  return kept + " " + "abcd".slice(copy) + " " + show(copy);
}
function resetAndReturn() {
  let found;
  const search = (): void => {
    found = "hit";
  };
  search();
  let copy = found;
  const kept = show(copy);
  copy = undefined;
  console.log("before the reset:", kept);
  return copy;
}
resetAndReturn();
console.log("reset copy:", resetCopy());

// A function expression called where it stands is part of the flow.
function inPlace(): string {
  let size: number | undefined = undefined;
  (() => {
    size = 2;
  })();
  return "abcd".slice(size);
}
console.log("called in place:", inPlace());

// Nothing ran since the assignment: the narrowing holds.
function current(): string {
  let from: number | undefined = undefined;
  const later = (): void => {
    from = 3;
  };
  const head = "abcd".slice(from);
  later();
  return head + " " + "abcd".slice(from);
}
console.log("before the call:", current());
