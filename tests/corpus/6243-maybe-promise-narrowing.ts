// Telling the arms of a maybe-promise union apart: `instanceof Promise`,
// the `then` probe through a cast, typeof, truthiness, equality, and
// Promise.resolve (which hands a promise back as is and wraps a value).

type MaybeString = string | Promise<string>;
function make(i: number): MaybeString {
  return i % 2 === 1 ? "s" + i : Promise.resolve("p" + i);
}

interface Box {
  v: number;
}
type MaybeBox = Box | Promise<Box>;
function box(i: number): MaybeBox {
  return i % 2 === 0 ? { v: i } : Promise.resolve({ v: i * 10 });
}
function isThenable(x: MaybeBox): boolean {
  return typeof (x as any).then === "function";
}

type Slot = { name: string; value: string | Promise<string> | null };
const slots: Slot[] = [
  { name: "a", value: "x" },
  { name: "b", value: Promise.resolve("y") },
  { name: "c", value: null },
];

async function main(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const v = make(i);
    if (v instanceof Promise) console.log(i, "promise", await v);
    else console.log(i, "value", v.toUpperCase());
    console.log(typeof v);
  }
  for (let i = 0; i < 3; i++) {
    const b = box(i);
    console.log(i, isThenable(b), typeof (b as Promise<Box>).then);
    if ((b as Promise<Box>).then) console.log("has then");
    console.log((await b).v);
  }
  for (const s of slots) {
    const v = await s.value;
    console.log(s.name, v === null ? "null" : v, s.value === null, s.value instanceof Promise, typeof s.value);
    if (s.value) console.log("truthy", s.name);
  }
  console.log(slots[1]!.value === slots[1]!.value);

  // Promise.resolve keeps a promise's identity and wraps a value.
  const p = Promise.resolve(7);
  const get = (b: boolean): number | Promise<number> => (b ? p : 3);
  const fromPromise = Promise.resolve(get(true));
  const fromValue = Promise.resolve(get(false));
  console.log(fromPromise === p, fromValue === p);
  const order: string[] = [];
  fromPromise.then((v) => order.push("promise" + v));
  fromValue.then((v) => order.push("value" + v));
  Promise.resolve().then(() => order.push("other"));
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
  console.log(order.join(","));
}
main();
