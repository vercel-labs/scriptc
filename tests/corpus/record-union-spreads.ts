// Object spreads of unions with several record arms.
// 1. The checker narrowed the source to fewer arms than its stored union
//    holds (an optional-chain discriminant test on an element read, a type
//    predicate): the spread copies the narrowed arm.
// 2. A union source spreads into one declared record: each arm copies only
//    the keys it holds, so a key the running arm lacks keeps the earlier
//    value or stays absent.
// Key order is printed sorted: per-arm creation order is a separate
// (pre-existing) key-order limitation.

type Block =
  | { type: "text"; text: string; textSignature?: string }
  | { type: "tool"; id: string; args: unknown; ns?: string }
  | { type: "image"; data: string };

function keys(value: object): string {
  return Object.keys(value).sort().join(",");
}

function update(content: Block[], index: number, args: unknown): string {
  const block = content[index];
  if (block?.type === "tool") {
    content[index] = { ...block, args };
    return "updated";
  }
  return "skipped";
}

function isTool(block: Block): block is Block & { type: "tool" } {
  return block.type === "tool";
}

function relabel(content: readonly Block[]): Block[] {
  return content.map((block) => (isTool(block) ? { ...block, args: "relabelled" } : block));
}

const blocks: Block[] = [
  { type: "tool", id: "1", args: 0 },
  { type: "text", text: "t" },
  { type: "tool", id: "2", args: 0, ns: "n" },
  { type: "image", data: "d" },
];
console.log(update(blocks, 0, 5), update(blocks, 1, 5), update(blocks, 2, [1]), update(blocks, 9, 5));
for (const block of blocks) {
  if (block.type === "tool") console.log(block.id, JSON.stringify(block.args), block.ns, keys(block));
  else console.log(block.type, keys(block));
}
for (const block of relabel(blocks)) {
  if (block.type === "tool") console.log(block.id, JSON.stringify(block.args), keys(block));
}

interface RequestOptions {
  apiKey?: string;
  headers?: Record<string, string>;
  env?: string;
  maxTokens?: number;
  label?: string;
}

function describe(options: RequestOptions): string {
  return [
    options.apiKey,
    options.headers?.["x"],
    options.env,
    options.maxTokens,
    options.label,
    keys(options),
    "apiKey" in options,
  ].join(" ");
}

// The `cond ? { a, b } : {}` credential idiom.
function route(sameProvider: boolean, apiKey: string | undefined, env: string | undefined): string {
  const auth = sameProvider ? { apiKey, env } : {};
  return describe({ label: "base", ...auth, maxTokens: 5 });
}
console.log(route(true, "k", "e"));
console.log(route(true, undefined, "e"));
console.log(route(false, "k", "e"));

type Source = { env?: string; apiKey: string } | { label: string; headers?: Record<string, string> } | undefined;

function merge(base: RequestOptions, source: Source): string {
  return describe({ ...base, ...source, maxTokens: 1 });
}
console.log(merge({ headers: { x: "h0" } }, { apiKey: "k", env: "e" }));
console.log(merge({ headers: { x: "h0" }, apiKey: "k0" }, { apiKey: "k" }));
console.log(merge({ headers: { x: "h0" } }, { label: "l" }));
console.log(merge({ headers: { x: "h0" } }, { label: "l", headers: { x: "h1" } }));
console.log(merge({ env: "e0" }, undefined));

export {};
