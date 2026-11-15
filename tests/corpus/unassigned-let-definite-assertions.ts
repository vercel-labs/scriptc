// `let x!: T` tells tsc not to check that x is assigned before it is
// read, in the declaring function's own code too. Until the first
// assignment the binding holds undefined.

let conn!: { host: string };
let port!: number;
let tag!: string;
function describe(): string {
  return [typeof conn, typeof port, typeof tag, conn === undefined, port === undefined, tag === undefined].join(":");
}
console.log(describe());
console.log(typeof conn, typeof port, typeof tag, conn === undefined, port ?? -1, tag ?? "none");
conn = { host: "h" };
port = 80;
tag = "t";
console.log(describe());
console.log(conn.host, port, tag);

function ownScope(): string {
  let x!: number;
  let y!: string;
  const before = typeof x + ":" + typeof y + ":" + (x === undefined) + ":" + (y ?? "dflt");
  x = 1;
  y = "y";
  return before + ">" + x + y;
}
console.log(ownScope());

// The promise-executor idiom: the callbacks are assigned inside a function
// the constructor calls, which tsc cannot see.
function deferred(): { promise: Promise<number>; resolve: (value: number) => void } {
  let resolve!: (value: number) => void;
  const promise = new Promise<number>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const d = deferred();
d.promise.then((value) => console.log("resolved", value));
d.resolve(42);

// Assigned by a callback that may never run: the call of an unassigned
// function throws Node's TypeError.
function neverAssigned(run: boolean): string {
  let callback!: () => string;
  const assign = (): void => {
    callback = () => "called";
  };
  if (run) assign();
  try {
    return callback();
  } catch (e) {
    return e instanceof TypeError ? "TypeError" : "other";
  }
}
console.log(neverAssigned(true), neverAssigned(false));

// Assigned before every read: nothing changes for these.
function assignedFirst(): number {
  let width!: number;
  let name!: string;
  width = 3;
  name = "abc";
  const area = (): number => width * name.length;
  return area();
}
console.log(assignedFirst());
