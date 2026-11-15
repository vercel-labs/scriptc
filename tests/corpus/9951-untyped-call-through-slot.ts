// A function is checked against what it declares, not against a slot it
// passed through. Each function below takes `any`, `unknown` or a record
// with only optional members, is stored in a slot whose function type names
// a record with required members, and is then called without that type: at
// a function type that takes `any`, through `any`, through `unknown` after a
// `typeof` test, and through `call`, `apply` and `bind`. JavaScript has one
// function object throughout, so the function receives every argument as it
// was given, and the slot's value is still the function.
interface Payload {
  diff: string;
  path: string;
}
type Show = (payload: Payload) => string;

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value !== "object") return `${typeof value}:${String(value)}`;
  return JSON.stringify(value);
}

function loose(payload: any): string {
  return `loose ${describe(payload)} diff=${String(payload?.diff)}`;
}
function opaque(payload: unknown): string {
  return `opaque ${describe(payload)}`;
}
function partial(payload: { diff?: string; path?: string }): string {
  return `partial ${describe(payload)} diff=${String(payload.diff)}`;
}

interface Definition {
  name: string;
  show: Show;
}
interface Sparse {
  name: string;
  show?: Show;
}
class Holder {
  show: Show;
  constructor(show: Show) {
    this.show = show;
  }
}
function through(show: Show): Show {
  return show;
}

// The slots one function passes through, each read back at the slot's type.
function slots(original: Show): [string, Show][] {
  const field: Definition = { name: "field", show: original };
  const list: Show[] = [original];
  const table = new Map<string, Show>();
  table.set("k", original);
  const sparse: Sparse = { name: "sparse", show: original };
  const table2 = { show: original };
  const spread: Definition = { name: "spread", ...table2 };
  let later: Show | undefined;
  later = original;
  return [
    ["field", field.show],
    ["element", list[0]!],
    ["map value", table.get("k")!],
    ["parameter and result", through(original)],
    ["class member", new Holder(original).show],
    ["optional member", sparse.show!],
    ["spread member", spread.show],
    ["union with undefined", later!],
  ];
}

const routes: [string, (show: Show, payload: any) => string][] = [
  [
    "wider function type",
    (show, payload) => {
      const wide: (payload: any) => string = show;
      return wide(payload);
    },
  ],
  [
    "any",
    (show, payload) => {
      const untyped: any = show;
      return untyped(payload);
    },
  ],
  [
    "unknown",
    (show, payload) => {
      const hidden: unknown = show;
      return typeof hidden === "function" ? hidden(payload) : "not a function";
    },
  ],
  [
    "call",
    (show, payload) => {
      const untyped: any = show;
      return untyped.call(undefined, payload);
    },
  ],
  [
    "apply",
    (show, payload) => {
      const untyped: any = show;
      return untyped.apply(undefined, [payload]);
    },
  ],
  [
    "bind",
    (show, payload) => {
      const untyped: any = show;
      return untyped.bind(undefined)(payload);
    },
  ],
];

const matching: Payload = { diff: "d", path: "p" };
const payloads: [string, any][] = [
  ["matching", matching],
  ["lacking a member", {}],
  ["wrong primitive", { diff: 1, path: "p" }],
  ["extra member", { diff: "d", path: "p", more: true }],
  ["undefined", undefined],
];

function run(label: string, original: Show, accepted: readonly string[]): void {
  for (const [slot, stored] of slots(original)) {
    for (const [route, call] of routes) {
      for (const [kind, payload] of payloads) {
        if (!accepted.includes(kind)) continue;
        let seen: string;
        try {
          seen = String(call(stored, payload));
        } catch (error) {
          seen = `THROWS ${(error as Error).message}`;
        }
        console.log(`${label} / ${slot} / ${route} / ${kind}: ${seen}`);
      }
    }
    console.log(`${label} / ${slot}: is the function ${String((stored as unknown) === (original as unknown))}`);
  }
}

// `any` and `unknown` take every argument.
const every = payloads.map(([kind]) => kind);
run("loose", loose, every);
run("opaque", opaque, every);
// A record of optional members takes the arguments its own type admits: the
// empty object too, which the slot's type excludes.
run("partial", partial, ["matching", "lacking a member", "extra member"]);

// A typed call through the slot's type, with a value of that type.
const definition: Definition = { name: "typed", show: loose };
console.log(definition.show({ diff: "typed", path: "call" }));
console.log(definition.show === definition.show, through(loose) === through(loose));
