// Class instances serialize their own data properties (methods live on the
// prototype, an arrow-function field is an own property holding a function
// and is omitted); a toJSON method replaces the value; a replacer function
// sees function-valued properties before they are dropped, and a replacer
// array selects properties by name.
class Counter {
  id: number;
  tag: string;
  bump = (): number => ++this.id;
  constructor(id: number, tag: string) {
    this.id = id;
    this.tag = tag;
  }
  double(): number {
    return this.id * 2;
  }
}

class Amount {
  cents: number;
  constructor(cents: number) {
    this.cents = cents;
  }
  toJSON(): string {
    return (this.cents / 100).toFixed(2);
  }
}

const counter = new Counter(3, "t");
console.log(JSON.stringify(counter), counter.double(), counter.bump());
console.log(JSON.stringify([counter, counter]));
console.log(JSON.stringify({ counter, callbacks: [() => 1], amount: new Amount(250) }));
const either: Array<{ value: Counter | (() => number) }> = [{ value: () => 1 }, { value: counter }];
console.log(JSON.stringify(either, null, 1));

const hooked = {
  secret: 1,
  toJSON(): string {
    return "custom";
  },
};
console.log(JSON.stringify(hooked), JSON.stringify({ wrap: hooked, list: [hooked] }));
console.log(JSON.stringify(hooked, null, 2), JSON.stringify([hooked], null, 2));

interface Shaped {
  secret: number;
  toJSON: () => { shown: number };
}
function shaped(value: Shaped): string {
  return JSON.stringify(value);
}
console.log(shaped({ secret: 1, toJSON: () => ({ shown: 2 }) }));

interface MaybeHooked {
  kept: number;
  toJSON?: () => string;
}
const without: MaybeHooked = { kept: 1 };
const withHook: MaybeHooked = { kept: 2, toJSON: () => "replaced" };
console.log(JSON.stringify(without), JSON.stringify(withHook), JSON.stringify([without, withHook]));

interface Options {
  name: string;
  onDone: () => void;
  retries: number;
  inner: { depth: number; visit?: () => void };
  list: Array<(() => void) | number>;
}
const options: Options = {
  name: "a",
  onDone: () => {},
  retries: 1,
  inner: { depth: 2, visit: () => {} },
  list: [() => {}, 7],
};
console.log(JSON.stringify(options, (key, value) => (typeof value === "number" ? value + 1 : value)));
console.log(JSON.stringify(options, (key, value) => (typeof value === "function" ? `fn:${key}` : value), "\t"));
console.log(JSON.stringify(options, ["name", "inner", "depth", "list"]));
console.log(JSON.stringify(options, null, 2));

// A cycle through records that also hold functions still throws.
interface Link {
  name: string;
  next: Link | null;
  visit?: () => void;
}
const first: Link = { name: "first", next: null, visit: () => {} };
const second: Link = { name: "second", next: first };
console.log(JSON.stringify(second));
first.next = second;
try {
  console.log(JSON.stringify(first));
} catch (error) {
  console.log((error as Error).name);
  console.log((error as Error).message);
}
