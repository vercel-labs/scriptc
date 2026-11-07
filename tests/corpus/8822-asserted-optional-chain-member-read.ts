// `(value as Wider | undefined)?.member`, where `Wider` adds an optional
// member the value's own type does not declare. Node erases the assertion
// and reads the property off the object: the value when the object carries
// the key, undefined when it does not, and undefined when the chain's
// receiver is absent. The dotted read through `undefined`, `null` and both,
// nested chains, defaults and presence tests are pinned beside the
// unguarded read.

interface Token {
  kind: "oauth";
  access: string;
}
type Gateway = { baseUrl: string; models: string[] };
type GatewayToken = Token & { gateway?: Gateway; label?: string; hits?: number };
interface NamedToken extends Token {
  label?: string;
}

function clean(config: unknown): Gateway | undefined {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return undefined;
  const { baseUrl, models } = config as Partial<Gateway>;
  if (typeof baseUrl !== "string" || !Array.isArray(models)) return undefined;
  return { baseUrl, models: models.filter((m) => typeof m === "string") };
}
function show(g: Gateway | undefined): string {
  return g === undefined ? "none" : `${g.baseUrl} ${g.models.join()}`;
}

function gatewayOf(token: Token | undefined): Gateway | undefined {
  return clean((token as GatewayToken | undefined)?.gateway);
}
function direct(token: Token): Gateway | undefined {
  return clean((token as GatewayToken).gateway);
}
function viaNull(token: Token | null): string {
  return show((token as GatewayToken | null)?.gateway);
}
function viaBoth(token: Token | null | undefined): string {
  return show((token as GatewayToken | null | undefined)?.gateway);
}
function nested(token: Token | undefined): string {
  return (token as GatewayToken | undefined)?.gateway?.baseUrl ?? "none";
}
function label(token: Token | undefined): string {
  return (token as NamedToken | undefined)?.label ?? "unnamed";
}
function labelLength(token: Token | undefined): number {
  return (token as NamedToken | undefined)?.label?.length ?? -1;
}
function hits(token: Token | undefined): number {
  return ((token as GatewayToken | undefined)?.hits ?? 0) + 1;
}
function declared(token: Token | undefined): string {
  return (token as GatewayToken | undefined)?.access ?? "none";
}
function probe(token: Token | undefined): boolean {
  return (token as GatewayToken | undefined)?.gateway !== undefined;
}

const plain: Token = { kind: "oauth", access: "a" };
const wide: GatewayToken = {
  ...plain,
  gateway: { baseUrl: "https://x", models: ["m"] },
  label: "w",
  hits: 4,
};
const parsed: Token = JSON.parse(
  '{"kind":"oauth","access":"p","gateway":{"baseUrl":"https://y","models":["n"]},"label":"j","hits":2}',
);
for (const token of [plain, wide, parsed]) {
  console.log(show(gatewayOf(token)), show(direct(token)), viaNull(token), viaBoth(token));
  console.log(nested(token), label(token), labelLength(token), hits(token), declared(token), probe(token));
}
console.log(show(gatewayOf(undefined)), viaNull(null), viaBoth(null), viaBoth(undefined));
console.log(
  nested(undefined),
  label(undefined),
  labelLength(undefined),
  hits(undefined),
  declared(undefined),
  probe(undefined),
);
