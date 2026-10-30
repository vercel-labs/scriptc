// Members typed by a distributive conditional over a generic parameter
// (`opts?: T extends "alpha" ? AlphaOpts : ...`), read inside the generic
// body: the instance's binding decides the layout, member by member of a
// literal union, and an all-never binding leaves an optional member that
// holds only undefined, as the concrete instantiation's member does.

type KnownApi = "alpha" | "beta" | "gamma";
type Api = KnownApi | (string & {});

interface AlphaOpts {
  fast?: boolean;
}
interface BetaOpts {
  depth?: number;
}

interface Base<TApi extends string> {
  id: string;
  api: TApi;
}

interface Item<TApi extends Api> extends Base<TApi> {
  kind?: "item";
  opts?: TApi extends "alpha" ? AlphaOpts : TApi extends "beta" ? BetaOpts : never;
}

interface Other extends Base<string> {
  kind: "other";
  size: number;
}

type AnyItem<TApi extends Api = Api> = Item<TApi> | Other;

interface Options<TApi extends Api> {
  name: string;
  items: readonly AnyItem<TApi>[];
}

interface Built<TApi extends Api> {
  name: string;
  all: () => readonly AnyItem<TApi>[];
  chat: () => Item<TApi>[];
  add: (item: AnyItem<TApi>) => void;
}

function describe(item: Item<Api>): string {
  return `${item.id}:${item.api}:${item.opts === undefined ? "-" : JSON.stringify(item.opts)}`;
}

function build<TApi extends Api = Api>(input: Options<TApi>): Built<TApi> {
  const baseline = input.items;
  let dynamic: readonly AnyItem<TApi>[] = [];
  const current = (): readonly AnyItem<TApi>[] => {
    const merged = [...baseline];
    for (const item of dynamic) merged.push(item);
    return merged;
  };
  return {
    name: input.name,
    all: current,
    chat: () => current().filter((item): item is Item<TApi> => item.kind !== "other"),
    add: (item) => {
      dynamic = [...dynamic, item];
    },
  };
}

function report<TApi extends Api>(built: Built<TApi>): void {
  console.log(`${built.name}: ${built.all().length} items, ${built.chat().length} chat`);
  for (const item of built.chat()) console.log(`  ${describe(item)}`);
}

const mixed: Built<"alpha" | "gamma"> = build({
  name: "mixed",
  items: [
    { id: "a1", api: "alpha", opts: { fast: true } },
    { id: "g1", api: "gamma" },
  ],
});
mixed.add({ id: "a2", api: "alpha" });
report(mixed);

const beta: Built<"beta"> = build({
  name: "beta",
  items: [
    { id: "b1", api: "beta", opts: { depth: 2 } },
    { id: "o1", api: "other", kind: "other", size: 1 },
  ],
});
beta.add({ id: "o2", api: "other", kind: "other", size: 3 });
report(beta);

const custom = build<string>({ name: "custom", items: [{ id: "c1", api: "custom" }] });
custom.add({ id: "c2", api: "custom" });
report(custom);

const open = build({ name: "open", items: [{ id: "x1", api: "external" }] });
report(open);
const first = open.chat()[0];
console.log(first === undefined ? "none" : first.opts === undefined ? "no opts" : "opts");
