// Conditional spreads beyond `...(c ? { field: v } : {})`: both arms
// populated, a conditional record-or-undefined source, a nested conditional,
// and a conditional contributor over an earlier field of the same name.
interface Options {
  application_type: string;
  scope?: string;
}
function body(metadata: Record<string, string>, scope: string | undefined): Options {
  return {
    ...metadata,
    application_type: metadata.application_type ?? "web",
    ...(scope ? { scope } : {}),
  };
}
const noScope = body({ application_type: "native" }, undefined);
console.log(JSON.stringify(noScope), Object.keys(noScope).join(","));
const withScope = body({ application_type: "native", scope: "stale" }, "read");
console.log(JSON.stringify(withScope), Object.keys(withScope).join(","));

// Conditional spread over an earlier contributor: the later arm wins.
function scoped(base: Options, scope: string | undefined): Options {
  return { ...base, ...(scope ? { scope } : {}) };
}
console.log(JSON.stringify(scoped({ application_type: "cli", scope: "keep" }, undefined)));
console.log(JSON.stringify(scoped({ application_type: "cli", scope: "keep" }, "replace")));

// A conditional record-or-undefined source (`c ? record : undefined`).
type Headers = Record<string, string>;
type Config = { modelOverrides?: Record<string, { headers?: Headers }> } | undefined;
function headers(config: Config, id: string, useOverrides: boolean): Headers {
  const overrides = useOverrides ? config?.modelOverrides?.[id]?.headers : undefined;
  return { accept: "json", ...overrides };
}
console.log(JSON.stringify(headers({ modelOverrides: { m1: { headers: { a: "1" } } } }, "m1", true)));
console.log(JSON.stringify(headers(undefined, "m2", true)));

// A nested conditional: three-way capability resolution.
interface Caps {
  images?: "kitty" | "iterm2" | null;
}
type Terminal = { images?: "kitty" | "iterm2" | false } | undefined;
function caps(terminal: Terminal): Caps {
  const images = terminal?.images;
  return {
    ...(images === "kitty" || images === "iterm2" ? { images } : images === false ? { images: null } : {}),
  };
}
for (const terminal of [{ images: "kitty" as const }, { images: false as const }, undefined]) {
  console.log(JSON.stringify(caps(terminal)));
}

// Both arms populated with different shapes: the running arm's own keys copy.
type A = { a: number; shared: string };
type B = { b: number; shared: string };
interface Joined {
  a?: number;
  b?: number;
  shared: string;
}
function pick(flag: boolean): Joined {
  const ra: A = { a: 1, shared: "s" };
  const rb: B = { b: 2, shared: "t" };
  const joined: Joined = { ...(flag ? ra : rb) };
  return joined;
}
for (const flag of [true, false]) {
  const joined = pick(flag);
  console.log(JSON.stringify(joined), Object.keys(joined).join(","));
}
