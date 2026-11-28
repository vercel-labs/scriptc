// A state hook reached through a dynamically held, generic interface — the
// setState/useState shape a UI runtime hands the app. The updater callback
// and the lazy initializer cross the erased generic boundary, and their
// array-of-records (and record) results keep the object the callback built,
// as in Node: an updater that returns the array it received leaves every
// reader of that array seeing its push.
interface Sample {
  users: number;
  revenue: number;
  latency: number;
  errors: number;
}

interface Hooks {
  useState<S>(seed: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void];
}

function seedHistory(): Sample[] {
  return [{ users: 1, revenue: 2, latency: 3, errors: 0 }];
}
const sample: Sample = { users: 9, revenue: 9, latency: 9, errors: 9 };

// The runtime's hooks object: one object the checker sees as the generic
// interface, while the compiler holds it as a runtime value.
const hooks = {
  useState(seed: unknown) {
    let value: unknown = typeof seed === "function" ? (seed as () => unknown)() : seed;
    const set = (next: unknown) => {
      value = typeof next === "function" ? (next as (previous: unknown) => unknown)(value) : next;
    };
    return [value, set];
  },
} as unknown as Hooks;

// The lazy initializer form: a named seed function returns the array.
const [history, setHistory] = hooks.useState<Sample[]>(seedHistory);
console.log(history.length, history[0].users);

// An updater that builds the next array from the previous one.
setHistory((previous) => {
  const next = previous.slice(1);
  next.push(sample);
  return next;
});
console.log(history.length);

// An updater that returns the array it received: the state array IS that
// array, so the push is visible through the seed's result.
const [rows, setRows] = hooks.useState<Sample[]>(seedHistory);
setRows((previous) => {
  previous.push(sample);
  return previous;
});
console.log(rows.length, rows[1].users);

// A record updater that mutates the object it received.
const sharedPoint: Sample = { users: 1, revenue: 2, latency: 3, errors: 0 };
const [point, setPoint] = hooks.useState<Sample>(sharedPoint);
setPoint((previous) => {
  previous.users = previous.users + 1;
  return previous;
});
console.log(sharedPoint.users, point.users);

// A primitive updater keeps working.
const [count, setCount] = hooks.useState<number>(1);
setCount((previous) => previous + 1);
console.log(count);
