// `...(c && { field: v })` where `c` is an optional value (`"1h" |
// undefined`) rather than a boolean: the falsy arm spreads nothing, exactly
// like a falsy primitive, and the `&&` result is the checker's
// `record | undefined` union — never the condition itself.
type Cache = { type: "ephemeral"; ttl?: string };
type Header = { retention: string; cacheControl?: Cache };

function cacheControl(retention: "long" | "none", longTtl: boolean): Header {
  if (retention === "none") return { retention };
  const ttl: "1h" | undefined = longTtl ? "1h" : undefined;
  return { retention, cacheControl: { type: "ephemeral", ...(ttl && { ttl }) } };
}

function direct(ttl: "1h" | undefined): { ttl?: string } {
  const value = ttl && { ttl };
  if (value) console.log("value", value.ttl);
  return { ...(ttl && { ttl }) };
}

function keyed(ttl: "1h" | undefined): Record<string, string> {
  const out: Record<string, string> = { base: "b", ...(ttl && { ttl }) };
  return out;
}

for (const ttl of ["1h", undefined] as ("1h" | undefined)[]) {
  console.log(JSON.stringify(cacheControl("long", ttl === "1h")));
  console.log(JSON.stringify(direct(ttl)));
  console.log(JSON.stringify(keyed(ttl)));
}
console.log(JSON.stringify(cacheControl("none", false)));
