// @requires-libnode
// A binding of a destructured parameter whose type names a class that only
// a package declares, in a program that reaches the package through a
// type-only import and an `import()` inside a function. The binding lowers
// outside every statement of its function, so its failure once skipped the
// whole body: the code the body reaches (the `import()`) never lowered, no
// refusal named the package, and the package never became a Node island.
// Declared functions, methods, static methods and constructors hold the
// same binding here; the plain parameter and the body's own destructuring
// are the forms that always compiled.
import type { LedgerClient } from "ledgerkit";

type LedgerFactory = (options: Record<string, unknown>) => LedgerClient;

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

// The same binding between defaults that are functions themselves.
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

async function readOnce({ ledgerFactory }: { ledgerFactory?: LedgerFactory }): Promise<string> {
  const factory = ledgerFactory ?? (await builtIn());
  const ledger = factory({ title: "async" });
  await ledger.entry("a");
  await ledger.entry("b");
  return `${ledger.title}:${await ledger.close()}`;
}

function makeNested({ deps: { ledgerFactory } }: { deps: { ledgerFactory?: LedgerFactory } }) {
  return async (): Promise<string> => (ledgerFactory ?? (await builtIn()))({ title: "nested" }).title;
}

class Shelf {
  readonly read: () => Promise<string>;
  constructor({ ledgerFactory }: { ledgerFactory?: LedgerFactory }) {
    this.read = async (): Promise<string> =>
      (ledgerFactory ?? (await builtIn()))({ title: "constructor" }).title;
  }
  reader({ ledgerFactory }: { ledgerFactory?: LedgerFactory }) {
    return async (): Promise<string> => (ledgerFactory ?? (await builtIn()))({ title: "method" }).title;
  }
  static reader({ ledgerFactory }: { ledgerFactory?: LedgerFactory }) {
    return async (): Promise<string> => (ledgerFactory ?? (await builtIn()))({ title: "static" }).title;
  }
}

// The forms that never needed the commit point.
function makePlain(ledgerFactory?: LedgerFactory) {
  return async (): Promise<string> => (ledgerFactory ?? (await builtIn()))({ title: "plain" }).title;
}
function makeFromBody(options: { ledgerFactory?: LedgerFactory }) {
  const { ledgerFactory } = options;
  return async (): Promise<string> => (ledgerFactory ?? (await builtIn()))({ title: "body" }).title;
}

const given = await builtIn();
const counted: LedgerFactory = (options) => given({ ...options, title: `given ${String(options.title)}` });

const results = [
  await makeReader({})("k"),
  await makeReader({ ledgerFactory: counted })("k2"),
  await makeNotedReader({})(),
  await makeNotedReader({ ledgerFactory: counted, label: () => "relabelled" })(),
  await readOnce({}),
  await readOnce({ ledgerFactory: counted }),
  await makeNested({ deps: {} })(),
  await makeNested({ deps: { ledgerFactory: counted } })(),
  await new Shelf({}).read(),
  await new Shelf({ ledgerFactory: counted }).read(),
  await new Shelf({}).reader({})(),
  await new Shelf({}).reader({ ledgerFactory: counted })(),
  await Shelf.reader({})(),
  await Shelf.reader({ ledgerFactory: counted })(),
  await makePlain()(),
  await makePlain(counted)(),
  await makeFromBody({})(),
  await makeFromBody({ ledgerFactory: counted })(),
];
for (const line of results) console.log(line);
