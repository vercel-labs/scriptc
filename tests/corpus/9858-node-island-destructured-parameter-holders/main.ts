// @requires-libnode
// Every function here declares, in a destructured parameter, a binding whose
// type names a class that only a package declares, and those functions'
// bodies are the only code that reaches the two loaders holding the
// package's `import()`. Such a binding lowers outside every statement of its
// function. When its failure skipped the whole body, nothing the compiler
// lowered named the package, the package never became a Node island, and the
// program was refused. With the binding a checked-dynamic slot each body
// lowers and the package is an island. The holders: a declared function, an
// async function, a binding among defaults, a nested pattern, a pattern with
// a default, a method, a static method, a constructor, and a function that
// is never called. No holder compiles by another route (no plain parameter,
// no destructuring in a body) and the top level calls no loader itself, so
// this program compiles only with the slot.
import type { LedgerClient } from "ledgerkit";

type LedgerFactory = (options: Record<string, unknown>) => LedgerClient;

// A loader declared before the holders.
const builtIn = async (): Promise<LedgerFactory> => {
  const { LedgerClient } = await import("ledgerkit");
  return (options) => new LedgerClient(options);
};

function makeReader({ ledgerFactory }: { ledgerFactory?: LedgerFactory }) {
  return async (key: string): Promise<string> => {
    const factory = ledgerFactory ?? (await builtIn());
    const ledger = factory({ title: "declared" });
    const row = await ledger.entry(key, { deep: true });
    return `${ledger.title}:${row.key}:${row.extra}`;
  };
}

async function readTwice({ ledgerFactory }: { ledgerFactory?: LedgerFactory }): Promise<string> {
  const factory = ledgerFactory ?? (await laterBuiltIn());
  const ledger = factory({ title: "async" });
  await ledger.entry("a");
  await ledger.entry("b");
  return `${ledger.title}:${await ledger.close()}`;
}

// The binding between defaults that are functions themselves.
function makeNotedReader({
  label = () => "noted",
  ledgerFactory,
  note = () => undefined,
}: {
  label?: () => string;
  ledgerFactory?: LedgerFactory;
  note?: (message: string) => void;
}) {
  note(label());
  return async (): Promise<string> => {
    const factory = ledgerFactory ?? (await builtIn());
    return `${label()}:${factory({ title: "among defaults" }).title}`;
  };
}

function makeNested({ deps: { ledgerFactory } }: { deps: { ledgerFactory?: LedgerFactory } }) {
  return async (): Promise<string> => (ledgerFactory ?? (await laterBuiltIn()))({ title: "nested" }).title;
}

function makeDefaulted({ ledgerFactory }: { ledgerFactory?: LedgerFactory } = {}) {
  return async (): Promise<string> => (ledgerFactory ?? (await builtIn()))({ title: "pattern default" }).title;
}

function makeUncalled({ ledgerFactory }: { ledgerFactory?: LedgerFactory }) {
  return async (): Promise<string> => (ledgerFactory ?? (await builtIn()))({ title: "never" }).title;
}

// One such member per class: a class that holds two or more of them is
// another program, which compiled before the slot existed (it is what the
// program 9868 holds).
class Shelf {
  readonly read: () => Promise<string>;
  constructor({ ledgerFactory }: { ledgerFactory?: LedgerFactory }) {
    this.read = async (): Promise<string> =>
      (ledgerFactory ?? (await laterBuiltIn()))({ title: "constructor" }).title;
  }
}
class Desk {
  reader({ ledgerFactory }: { ledgerFactory?: LedgerFactory }) {
    return async (): Promise<string> => (ledgerFactory ?? (await builtIn()))({ title: "method" }).title;
  }
}
class Counter {
  static reader({ ledgerFactory }: { ledgerFactory?: LedgerFactory }) {
    return async (): Promise<string> => (ledgerFactory ?? (await laterBuiltIn()))({ title: "static" }).title;
  }
}

// The same binding holding a function rather than `undefined`. The function
// is made inside a holder and handed to the others from there: a variable of
// the factory's type in a statement of the top level is another route, which
// this program leaves out.
async function relay({ ledgerFactory }: { ledgerFactory?: LedgerFactory }): Promise<string[]> {
  const base = ledgerFactory ?? (await builtIn());
  const marked: LedgerFactory = (options) => base({ ...options, title: `given ${String(options.title)}` });
  return [
    await makeReader({ ledgerFactory: marked })("k2"),
    await readTwice({ ledgerFactory: marked }),
    await makeNotedReader({
      ledgerFactory: marked,
      label: () => "relabelled",
      note: (message) => {
        notes.push(message);
      },
    })(),
    await makeNested({ deps: { ledgerFactory: marked } })(),
    await makeDefaulted({ ledgerFactory: marked })(),
    await new Shelf({ ledgerFactory: marked }).read(),
    await new Desk().reader({ ledgerFactory: marked })(),
    await Counter.reader({ ledgerFactory: marked })(),
  ];
}

const notes: string[] = [];
const results = [
  await makeReader({})("k"),
  await readTwice({}),
  await makeNotedReader({})(),
  await makeNested({ deps: {} })(),
  await makeDefaulted()(),
  await makeDefaulted({})(),
  await new Shelf({}).read(),
  await new Desk().reader({})(),
  await Counter.reader({})(),
  await (process.argv.length > 40 ? makeUncalled({})() : Promise.resolve("not called")),
  ...(await relay({})),
];
for (const line of results) console.log(line);
console.log(notes.join(","));

// A loader declared after everything that reaches it.
async function laterBuiltIn(): Promise<LedgerFactory> {
  const { LedgerClient } = await import("ledgerkit");
  return (options) => new LedgerClient(options);
}
