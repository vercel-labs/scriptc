// A number[] or string[] seen as `(T | undefined)[]` is the same array, as
// in Node: undefined written through either name is visible through both,
// whether the wider view is a cast, a binding or a parameter.

const c: number[] = [1.5, 2];
(c as (number | undefined)[])[1] = undefined;
console.log(c);
const e: number[] = [1.5, 2];
const f = e as (number | undefined)[];
f[1] = undefined;
console.log(e, f, e === f);

function clearFirst(values: (number | undefined)[]): void {
  values[0] = undefined;
  values.push(undefined, 4);
}
const a: number[] = [1, 2, 3];
clearFirst(a);
console.log(a, a.length, a.indexOf(4), a.includes(undefined as unknown as number));

const names: string[] = ["x"];
const wider: (string | undefined)[] = names;
wider.push(undefined);
wider.unshift(undefined);
console.log(names, wider === names, names.length, JSON.stringify(names));

// The wider arrays themselves: literals, pushes, splices and copies keep
// their undefined elements.
const lit: (number | undefined)[] = [1, undefined, 3];
const maybe = (i: number): number | undefined => (i % 2 ? i : undefined);
const built: (number | undefined)[] = [];
for (let i = 0; i < 4; i++) built.push(maybe(i));
built.splice(1, 0, undefined);
console.log(lit, built, lit.indexOf(undefined), built.filter((x): boolean => x === undefined).length);
console.log(built.map((x) => x ?? -1), built.find((x) => x !== undefined), [...built].reverse());
let sum = 0;
for (const x of built) sum += x ?? 0;
console.log(sum, built.join("-"), JSON.stringify(built));

const flags: (boolean | undefined)[] = [true, undefined, false];
const strs: (string | undefined)[] = ["a", undefined];
console.log(flags, flags.filter(Boolean).length, strs.map((s) => s?.toUpperCase()));

// Values from other containers keep their undefined.
const m = new Map<string, number | undefined>([["a", undefined], ["b", 2]]);
const fromMap = [...m.values()];
const fromSet = Array.from(new Set<string | undefined>(["s", undefined]));
const sized = Array.from<number | undefined>({ length: 2 });
console.log(fromMap, fromSet, sized, sized.length);
const dict: { [key: string]: number | undefined } = { a: 1, b: undefined };
console.log(Object.values(dict));

// An asserted element that is undefined throws a catchable TypeError.
function lengthAt(items: (string | undefined)[], i: number): number {
  try {
    return items[i]!.length;
  } catch {
    return -1;
  }
}
console.log(lengthAt(strs, 0), lengthAt(strs, 1));
