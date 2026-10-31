// Records of functions used as dispatch tables: keyed reads consumed at once
// (`t[k]!(…)`, `t[k]?.(…)`, a checked local), missing keys, handlers that
// declare fewer parameters than the table's type, handlers that replace,
// delete or re-add table entries (their own included) while they run, and
// key order after such mutation.
type Handler = (x: number, y: number) => number;

let log: string[] = [];

function make(tag: string): Handler {
  let calls = 0;
  return (x, y) => {
    calls++;
    log.push(tag + ":" + calls);
    return x * 10 + y;
  };
}

const table: Record<string, Handler> = {
  add: (x, y) => x + y,
  neg: (x) => -x,
  pow: (x, y) => x ** y,
  made: make("made"),
};

function keys(): string[] {
  return process.argv.length > 99 ? [] : ["add", "neg", "pow", "made", "missing", ""];
}

for (const k of keys()) {
  const h = table[k] as Handler | undefined;
  console.log(JSON.stringify(k), typeof h, h === undefined, h !== undefined && h === table[k]);
  console.log("  optional", table[k]?.(3, 4) ?? "none");
  if (h) console.log("  checked", h(2, 5));
  try {
    console.log("  asserted", table[k]!(5, 2));
  } catch (e) {
    console.log("  asserted threw", (e as Error).name);
  }
}

// A handler that replaces its own entry while it runs: the replaced closure
// keeps running with its captured state.
function selfReplacing(): Handler {
  const state = { hits: 0, label: "first" };
  return (x, y) => {
    table["swap"] = make("second");
    state.hits++;
    log.push(state.label + " still running after replace, hits " + state.hits);
    return x + y + state.hits;
  };
}
table["swap"] = selfReplacing();
console.log("swap 1", table["swap"]!(1, 2));
console.log("swap 2", table["swap"]?.(1, 2));
console.log("swap 3", table["swap"]!(1, 2));

// A handler that deletes its own entry.
function selfDeleting(name: string): Handler {
  const captured = [name, "captured"];
  return (x) => {
    delete table[name];
    log.push(captured.join(" ") + " after delete");
    return x;
  };
}
table["gone"] = selfDeleting("gone");
const goneKey = keys()[0] === "add" ? "gone" : "add";
console.log("gone", table[goneKey]?.(7, 0) ?? "none", table[goneKey]?.(7, 0) ?? "none");

// A checked local keeps its closure after the entry changes.
table["kept"] = make("kept-old");
const kept = table["kept"] as Handler | undefined;
table["kept"] = make("kept-new");
delete table["kept"];
if (kept) console.log("kept", kept(4, 4));
console.log("kept entry", table["kept"] === undefined);

// Iteration while handlers add and delete keys: key order follows inserts.
const order: Record<string, Handler> = {
  b: (x) => x + 1,
  a: (x) => {
    delete order["c"];
    order["z"] = (v) => v * 2;
    return x + 2;
  },
  c: (x) => x + 3,
  "1": (x) => x + 4,
};
for (const k in order) console.log("in", k, order[k]?.(1, 0));
console.log("keys", Object.keys(order).join(","));
for (const k of Object.keys(order)) {
  order[k + k] = (x) => x;
  console.log("of", k, order[k]!(10, 0));
}
console.log("keys", Object.keys(order).join(","));

// Reassigning the table binding itself from inside a handler.
let current: Record<string, Handler> = {
  go: (x) => {
    current = { go: (y) => y * 100 };
    const local = [x, x];
    return local[0]! + local[1]!;
  },
};
console.log("rebind", current["go"]!(3, 0), current["go"]!(3, 0));
console.log(log.join("\n"));
