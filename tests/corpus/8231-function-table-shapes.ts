// Function dispatch through other table shapes: Map<string, fn>, arrays of
// handlers, object literals of methods (with and without `this`), handler
// mutation of the Map during calls, and adapters for handlers that declare
// fewer parameters than the table type.
type Op = (acc: number, arg: number) => number;

const trace: string[] = [];
const byName = new Map<string, Op>();
byName.set("add", (acc, arg) => acc + arg);
byName.set("half", (acc) => acc / 2);
byName.set("reset", () => {
  byName.delete("reset");
  byName.set("reset", (acc) => acc - 1);
  trace.push("reset replaced itself");
  return 0;
});
byName.set("clear", (acc) => {
  const keep = [acc, "before clear"];
  byName.clear();
  trace.push(keep.join(" ") + ", size " + byName.size);
  return acc;
});

function program(): string[] {
  return process.argv.length > 99 ? [] : ["add", "half", "nop", "reset", "reset", "add", "clear", "add"];
}

let acc = 8;
for (const name of program()) {
  const handler = byName.get(name);
  if (handler !== undefined) acc = handler(acc, 3);
  else trace.push("no " + name);
  console.log(name, acc, byName.get(name)?.(1, 1) ?? "-");
}

const byCode: Op[] = [(a, b) => a - b, (a) => a * 3, (a, b) => Math.max(a, b)];
let total = 1;
for (let i = 0; i < 9; i++) {
  total = byCode[i % 4]?.(total, i) ?? total + 100;
  if (i % 4 < byCode.length) total = byCode[i % 4]!(total, 1);
}
console.log("array", total);

const counter = {
  base: 5,
  bump(by: number): number {
    this.base += by;
    return this.base;
  },
  twice(by: number): number {
    return this.bump(by) + this.bump(by);
  },
  plain(by: number): number {
    return by * 2;
  },
};
console.log("methods", counter.bump(1), counter.twice(2), counter.plain(3), counter["plain"](4));

// Methods that read `this`, called through computed keys and through a
// signature adapter (a method declaring fewer parameters than its type).
interface Account {
  balance: number;
  deposit: (amount: number, note: string) => number;
  withdraw: (amount: number, note: string) => number;
  peek: (amount: number, note: string) => number;
}
const account: Account = {
  balance: 10,
  deposit(amount) {
    this.balance += amount;
    return this.balance;
  },
  withdraw(amount, note) {
    this.balance -= amount;
    trace.push("withdraw " + note);
    return this.balance;
  },
  peek: (amount) => amount,
};
for (const op of ["deposit", "withdraw", "peek", "deposit"] as const) {
  console.log(op, account[op](5, "n-" + op), account.balance);
}
const detached = account.peek;
console.log("detached", detached(3, "x"));

interface Machine {
  state: string;
  on: Record<string, (m: Machine, input: number) => string>;
}
const machine: Machine = {
  state: "idle",
  on: {
    idle: (m, input) => (input > 0 ? "running" : m.state),
    running: (m, input) => {
      if (input < 0) {
        m.on["stopped"] = () => "idle";
        return "stopped";
      }
      return m.state;
    },
  },
};
for (const input of [0, 1, 2, -1, 5, 3]) {
  const next = machine.on[machine.state]?.(machine, input) ?? machine.state;
  console.log("machine", machine.state, input, "->", next);
  machine.state = next;
}
console.log(trace.join("\n"));
