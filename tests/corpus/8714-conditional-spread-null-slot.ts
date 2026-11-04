// `...(cond ? { k: v } : {})` into an index-signature slot WITHOUT an
// undefined arm (`null | string`): the empty arm cannot ride the value
// slot's undefined tag, so the literal takes the checked-dynamic form,
// which writes the key only when the condition holds.
type ProviderHeaders = Record<string, string | null>;

function build(apiKey: string | undefined): ProviderHeaders {
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

function buildBoth(first: string | undefined, second: number): ProviderHeaders {
  return {
    "x-first": first ?? null,
    ...(first ? { "x-a": first } : {}),
    ...(second > 1 ? { "x-b": String(second) } : {}),
  };
}

console.log(JSON.stringify(build("k1")));
console.log(JSON.stringify(build(undefined)));
console.log(Object.keys(build(undefined)).join(","));
console.log(JSON.stringify(buildBoth("v", 2)));
console.log(JSON.stringify(buildBoth(undefined, 0)));
console.log(Object.keys(buildBoth(undefined, 1)).join(","));
