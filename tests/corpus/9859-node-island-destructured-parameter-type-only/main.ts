// @requires-libnode
// A destructured parameter's binding whose type names a class that a package
// only declares, in a program that imports the type and never loads the
// package: there is no `import()` anywhere. The binding lowers outside every
// statement of its function, and its failure once skipped the function's
// whole body and refused the program. As a checked-dynamic slot it lets each
// body lower, and the package the type comes from is a Node island though
// nothing loads it. The holders: a declared function, an async function, a
// binding among defaults, a nested pattern, a pattern with a default, a
// method, a static method, a constructor, and a function that is never
// called. No factory can exist here, so every holder that runs takes the
// fallback, which throws.
import type { LedgerClient } from "ledgerkit";

type LedgerFactory = (options: Record<string, unknown>) => LedgerClient;

let asked = 0;
const builtIn = async (): Promise<LedgerFactory> => {
  asked++;
  throw new Error(`no ledger here (${asked})`);
};

function makeReader({ ledgerFactory }: { ledgerFactory?: LedgerFactory }) {
  return async (): Promise<string> => {
    const factory = ledgerFactory ?? (await builtIn());
    return factory({ title: "declared" }).title;
  };
}

async function readNow({ ledgerFactory }: { ledgerFactory?: LedgerFactory }): Promise<string> {
  const factory = ledgerFactory ?? (await builtIn());
  return factory({ title: "async" }).title;
}

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
  return async (): Promise<string> => (ledgerFactory ?? (await builtIn()))({ title: "nested" }).title;
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
      (ledgerFactory ?? (await builtIn()))({ title: "constructor" }).title;
  }
}
class Desk {
  reader({ ledgerFactory }: { ledgerFactory?: LedgerFactory }) {
    return async (): Promise<string> => (ledgerFactory ?? (await builtIn()))({ title: "method" }).title;
  }
}
class Counter {
  static reader({ ledgerFactory }: { ledgerFactory?: LedgerFactory }) {
    return async (): Promise<string> => (ledgerFactory ?? (await builtIn()))({ title: "static" }).title;
  }
}

const notes: string[] = [];
async function report(name: string, pending: Promise<string>): Promise<void> {
  try {
    console.log(`${name}: ${await pending}`);
  } catch (error) {
    console.log(`${name} failed: ${(error as Error).message}`);
  }
}

await report("declared", makeReader({})());
await report("async", readNow({}));
await report(
  "among defaults",
  makeNotedReader({
    note: (message) => {
      notes.push(message);
    },
  })(),
);
await report("nested", makeNested({ deps: {} })());
await report("pattern default", makeDefaulted()());
await report("pattern default given", makeDefaulted({})());
await report("constructor", new Shelf({}).read());
await report("method", new Desk().reader({})());
await report("static", Counter.reader({})());
await report("never called", process.argv.length > 40 ? makeUncalled({})() : Promise.resolve("not called"));
console.log(notes.join(","), asked);
