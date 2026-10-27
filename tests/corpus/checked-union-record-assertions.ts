// Assertions whose target no static conversion reaches: a union asserted to
// the one layout some of its arms convert into, and records or arrays whose
// member types the assertion narrows. The value is checked against the
// asserted type; these programs assert truthfully, so they run as in Node.

type Api = "alpha" | "beta" | (string & {});

interface Streams {
  stream: (x: number) => string;
  fetch?: (x: number) => string;
}

interface Options<TApi extends Api> {
  name: string;
  api?: Streams | Partial<Record<TApi, Streams>>;
}

function isStreams(value: unknown): value is Streams {
  return typeof value === "object" && value !== null && "stream" in value && typeof value.stream === "function";
}

function run<TApi extends Api>(input: Options<TApi>): string[] {
  const single = input.api && isStreams(input.api) ? input.api : undefined;
  const byApi = single || !input.api ? undefined : (input.api as Partial<Record<string, Streams>>);
  const all = single ? [single] : Object.values(byApi ?? {}).filter((entry) => entry !== undefined);
  return all.map((entry) => `${input.name}:${entry.stream(all.length)}`);
}

const shared: Streams = { stream: (x) => `shared${x}` };
console.log(run({ name: "single", api: shared }));
console.log(run<"alpha" | "beta">({ name: "map", api: { alpha: { stream: (x) => `alpha${x}` }, beta: shared } }));
console.log(run<"alpha">({ name: "none" }));

type KnownKind = "alpha" | "beta" | "gamma";

interface AlphaOpts {
  fast?: boolean;
}
interface BetaOpts {
  depth?: number;
}

interface Item<TKind extends string> {
  id: string;
  kind: TKind;
  opts?: TKind extends "alpha" ? AlphaOpts : TKind extends "beta" ? BetaOpts : never;
}

interface Other {
  id: string;
  kind: string;
  size: number;
}

const alpha: Item<"alpha"> = { id: "a1", kind: "alpha", opts: { fast: true } };
const gamma: Item<"gamma"> = { id: "g1", kind: "gamma" };
const other: Other = { id: "o1", kind: "other", size: 2 };

const everything: (Item<KnownKind> | Other)[] = [alpha, gamma, other, { id: "g2", kind: "gamma" }];
const gammas = everything.filter((entry) => entry.kind === "gamma") as Item<"gamma">[];
console.log(gammas.length, gammas.map((entry) => `${entry.id}:${entry.opts === undefined}`).join(","));

const items: Item<KnownKind>[] = [gamma, alpha];
const first = items[0]! as Item<"gamma">;
console.log(first.id, first.kind, first.opts === undefined);

const stored: { list: (Item<KnownKind> | Other)[] } = { list: [gamma] };
const restored = stored.list as Item<"gamma">[];
console.log(JSON.stringify(restored));
