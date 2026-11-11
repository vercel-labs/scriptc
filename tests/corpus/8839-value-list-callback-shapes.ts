// Every shape of callback that the methods of a list made by Object.values
// can be handed: the native loops call the ones with a fixed argument list,
// and the others (a rest parameter, a function held as `any`, a generator
// function, a standard-library function) are called through the list's
// checked-dynamic view, where they see every argument JavaScript passes,
// whether the list holds the object's values or what a link of the chain
// made of them.
type Dict = Record<string, object>;
const d: Dict = { a: { id: "a", n: 3 }, b: { id: "b", n: 1 }, c: { id: "c", n: 2 } };
const nOf = (value: object): number => (value as { n: number }).n;
const idOf = (value: object): string => (value as { id: string }).id;

// Rest parameters, alone and after a named parameter, in every method.
console.log(Object.values(d).map((...args: unknown[]) => args.length).join(","));
console.log(Object.values(d).map((value: object, ...more: unknown[]) => idOf(value) + more.length).join(","));
console.log(Object.values(d).map((...args: (object | number | object[])[]) => args.length).join(","));
console.log(Object.values(d).filter((...args: unknown[]) => nOf(args[0] as object) > 1).length);
Object.values(d).forEach((...args: unknown[]) => console.log(args.length, args[1]));
console.log(Object.values(d).every((...args: unknown[]) => args.length === 3));
console.log(Object.values(d).some((...args: unknown[]) => args[1] === 2));
console.log(Object.values(d).findIndex((...args: unknown[]) => args[1] === 2));
console.log(JSON.stringify(Object.values(d).flatMap((...args: unknown[]) => [args.length, args[1]])));
console.log(
  JSON.stringify(
    Object.values(d)
      .filter((value) => nOf(value) > 0)
      .sort((...args: object[]) => nOf(args[0]!) - nOf(args[1]!)),
  ),
);

// What a rest parameter holds: the element itself, the index, and one
// array for the whole walk.
const lists: unknown[] = [];
console.log(
  Object.values(d)
    .map((...args: unknown[]) => {
      lists.push(args[2]);
      return Array.isArray(args[2]) && args[0] === d[idOf(args[0] as object)];
    })
    .join(","),
  lists[0] === lists[1],
);

// A rest callback that is not written in place: a function declaration, a
// constant, a method, the result of a generic function, an async function.
function count(...args: unknown[]): number {
  return args.length;
}
const countArrow = (...args: unknown[]): number => args.length;
const helper = {
  count(...args: unknown[]): number {
    return args.length;
  },
};
function pass<F>(f: F): F {
  return f;
}
console.log(Object.values(d).map(count).join(","), Object.values(d).filter(count).length);
console.log(Object.values(d).map(countArrow).join(","), Object.values(d).map(helper.count).join(","));
console.log(Object.values(d).map(pass((...args: unknown[]) => args.length)).join(","));

// Where a list goes after a method that ran on the view.
const counts = Object.values(d).map((...args: unknown[]) => args.length);
const typed: number[] = Object.values(d).map((...args: unknown[]) => args.length);
console.log(counts.length, counts[1], typed.length, [...counts].join(""), JSON.stringify(counts));
console.log(
  Object.values(d)
    .filter((...args: unknown[]) => args.length === 3)
    .map((value) => idOf(value))
    .join(","),
  Object.values(d)
    .filter((value) => nOf(value) > 1)
    .map((...args: unknown[]) => args.length)
    .join(","),
);
let walked = "";
for (const value of Object.values(d).filter((...args: unknown[]) => args[1] !== 1)) walked += idOf(value);
console.log(walked);

// The same callbacks after a link of the chain that made a typed list.
console.log(
  Object.values(d)
    .map((value) => nOf(value))
    .map((...args: unknown[]) => args.length)
    .join(","),
  Object.values(d)
    .map((value) => idOf(value))
    .filter((...args: unknown[]) => args[1] !== 1)
    .join(","),
);
Object.values(d)
  .map((value) => nOf(value))
  .forEach((...args: unknown[]) => console.log(args.length, args[0], args[1]));
console.log(
  Object.values(d)
    .map((value) => nOf(value))
    .some((...args: unknown[]) => args[0] === 2),
  Object.values(d)
    .map((value) => nOf(value))
    .every((...args: unknown[]) => args.length === 3),
  Object.values(d)
    .map((value) => nOf(value))
    .findIndex((...args: unknown[]) => args[0] === 2),
);
console.log(
  Object.values(d)
    .map((value) => nOf(value))
    .sort((...args: number[]) => args[0]! - args[1]!)
    .join(","),
);
console.log(
  Object.values(d)
    .map((value) => nOf(value))
    .map(String)
    .join("|"),
  Object.values(d)
    .map((value) => idOf(value))
    .map(Number)
    .join(","),
);
const typedLists: unknown[] = [];
console.log(
  Object.values(d)
    .map((value) => nOf(value))
    .map((...args: unknown[]) => {
      typedLists.push(args[2]);
      return Array.isArray(args[2]);
    })
    .join(","),
  typedLists[0] === typedLists[1],
);

// Default and optional parameters.
console.log(
  Object.values(d)
    .map((value: object, index = 7, list: object[] = []) => idOf(value) + index + list.length)
    .join(","),
);
console.log(
  Object.values(d)
    .map((value: object = { id: "z" }) => idOf(value))
    .join(","),
);
console.log(
  Object.values(d)
    .map((value: object, index?: number, list?: object[]) => idOf(value) + (index ?? -1) + (list ? list.length : -1))
    .join(","),
);
console.log(Object.values(d).filter((value: object, index = 9) => nOf(value) > index).length);
console.log(JSON.stringify(Object.values(d).flatMap((value: object, index = 9) => [idOf(value), index])));
console.log(
  Object.values(d).reduce((sum: number, value: object, index = 9, list: object[] = []) => sum + nOf(value) + index + list.length, 0),
);

// A function expression that reads `arguments`.
console.log(
  Object.values(d)
    .map(function (value: object) {
      return idOf(value) + arguments.length;
    })
    .join(","),
);
Object.values(d).forEach(function () {
  console.log(arguments.length, arguments[1]);
});
console.log(
  Object.values(d).filter(function () {
    return arguments[1] > 0;
  }).length,
);

// A bound function, a function held in a variable, methods, overloads, a
// thisArg.
function tag(this: { p: string }, value: object, index: number): string {
  return this.p + idOf(value) + index;
}
let pick: (value: object, index: number) => string = (value, index) => idOf(value) + index;
if (Object.keys(d).length > 5) pick = () => "none";
class Tagger {
  p = "#";
  tag(value: object): string {
    return idOf(value);
  }
  static of(value: object, index: number): string {
    return idOf(value) + index;
  }
}
const tagger = new Tagger();
function over(value: object): string;
function over(value: object, index: number): string;
function over(value: object, index?: number): string {
  return idOf(value) + (index === undefined ? "?" : index);
}
function each<T, R>(f: (value: T, index: number) => R): (value: T, index: number) => R {
  return f;
}
console.log(Object.values(d).map(tag.bind({ p: ">" })).join(","), Object.values(d).map(pick).join(","));
console.log(Object.values(d).map(tagger.tag).join(","), Object.values(d).map(Tagger.of).join(","));
console.log(Object.values(d).map(over).join(","));
console.log(
  Object.values(d)
    .map(each((value: object, index: number) => idOf(value) + index))
    .join(","),
);
console.log(
  Object.values(d)
    .map(function (this: { p: string }, value: object) {
      return this.p + idOf(value);
    }, { p: "@" })
    .join(","),
);

// Functions held as `any`.
const loose: any = (...args: unknown[]) => args.length;
const table: Record<string, any> = { f: (value: object) => idOf(value) };
console.log(Object.values(d).map(loose).join(","), Object.values(d).map(table.f).join(","));

// Standard-library functions.
console.log(Object.values(d).map(String).join("|"), Object.values(d).filter(Boolean).length);
console.log(Object.values(d).every(Boolean), Object.values(d).some(Boolean));
console.log(Object.values(d).map(Number).join(","), Object.values(d).filter(Number).length);
console.log(Object.values(d).map(Array.isArray).join(","), Object.values(d).map(Object.keys).join("|"));
console.log(
  Object.values(d)
    .map(JSON.stringify as (value: object) => string)
    .join("|"),
);

// The same functions through a binding: the value decides, not the name
// the call uses.
const toNumber = Number;
const toText = String;
const toFlag = Boolean;
console.log(Object.values(d).map(toNumber).join(","), Object.values(d).map(toText).join("|"));
console.log(Object.values(d).filter(toFlag).length, Object.values(d).map(toFlag).join(","));
console.log(Object.values(d).every(toFlag), Object.values(d).some(toFlag), Object.values(d).filter(toNumber).length);
console.log(
  Object.values(d)
    .map((value) => idOf(value))
    .map(toNumber)
    .join(","),
  Object.values(d)
    .map((value) => idOf(value).length)
    .map(toText)
    .join("|"),
  Object.values(d)
    .map((value) => nOf(value) - 1)
    .filter(toFlag)
    .join(","),
);

// A generator function.
console.log(
  Object.values(d)
    .map(function* (value: object) {
      yield idOf(value);
    })
    .map((it) => [...it].join(""))
    .join(","),
);

// Async callbacks, with and without a rest parameter.
async function main(): Promise<void> {
  console.log((await Promise.all(Object.values(d).map(async (value, index) => idOf(value) + index))).join(","));
  console.log((await Promise.all(Object.values(d).map(async (...args: unknown[]) => args.length))).join(","));
}
void main();
