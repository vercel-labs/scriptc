// `instanceof` in TypeScript against right-hand sides that are not class names:
// constructor-typed parameters, constructors read from tables as any, builtin
// constructors held as values, and class values held in properties.
class Animal {
  name: string;
  constructor(name: string) { this.name = name; }
}
class Dog extends Animal {
  bark(): string { return this.name + " barks"; }
}
class Plain { v = 1; }

// Constructor-typed parameters.
function isA(value: unknown, C: new (...args: never[]) => unknown): boolean {
  return value instanceof C;
}
const dog = new Dog("rex");
console.log(isA(dog, Animal), isA(dog, Dog), isA(new Animal("a"), Dog), isA(new Plain(), Animal), isA(dog, Plain));
console.log(isA(new Date(0), Date), isA(new Map(), Map), isA({}, Map), isA("text", Animal), isA(null, Animal));

// Narrowing through a constructor-typed value.
function describe(value: Animal, C: typeof Dog): string {
  if (value instanceof C) return value.bark();
  return value.name;
}
console.log(describe(dog, Dog), describe(new Animal("cat"), Dog));

// A table of constructors read as any.
const table: Record<string, any> = { Date, Map, Set, RegExp, Promise, WeakMap, WeakSet, Dog };
const samples: unknown[] = [new Date(0), new Map(), new Set(), /x/, Promise.resolve(1), new WeakMap(), new WeakSet(), [1], dog, { a: 1 }];
for (const name of Object.keys(table)) {
  const C = table[name];
  console.log(name, samples.map((s) => (s instanceof C ? 1 : 0)).join(""));
}

// A right-hand side that is not callable throws Node's TypeError.
const notCallable: any = {};
try {
  console.log(dog instanceof notCallable);
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}

// Typed native values passed as unknown, against builtin constructors held as any.
const typedValues: [string, unknown][] = [
  ["map", new Map<string, number>([["a", 1]])],
  ["set", new Set<number>([1])],
  ["regex", /a/g],
  ["promise", Promise.resolve(1)],
  ["weak", new WeakMap<object, number>()],
  ["date", new Date(5)],
  ["array", [1]],
  ["record", { a: 1 }],
];
const builtins: Record<string, any> = { Map, Set, RegExp, Promise, WeakMap, Date };
for (const [label, value] of typedValues) {
  console.log(label, Object.keys(builtins).map((name) => (value instanceof builtins[name] ? 1 : 0)).join(""));
}

// Class values held in properties, against native values and instances.
const holder = { type: Dog, base: Animal };
const map = new Map<string, number>();
const pattern = /x/;
console.log(map instanceof holder.type, pattern instanceof holder.base, dog instanceof holder.type, dog instanceof holder.base);
