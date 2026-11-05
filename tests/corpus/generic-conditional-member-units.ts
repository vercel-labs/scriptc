// Members typed by a distributive conditional over a generic parameter whose
// binding selects `unknown`, `{}`, `undefined` or `null` for some members,
// read inside the generic body. The checker's union of the results decides the
// layout: `unknown` and `{}` absorb the other results, and `undefined` and
// `null` are the union's unit arms, as in the concrete instantiation.

type Kind = "alpha" | "beta" | "gamma" | (string & {});

interface BetaOpts {
  depth: number;
}

interface Loose<K extends Kind> {
  kind: K;
  meta: K extends "alpha" ? unknown : K extends "beta" ? BetaOpts : never;
}

interface Empty<K extends Kind> {
  kind: K;
  meta: K extends "alpha" ? {} : K extends "beta" ? BetaOpts : never;
}

interface Units<K extends Kind> {
  kind: K;
  meta: K extends "alpha" ? undefined : K extends "beta" ? BetaOpts : K extends "gamma" ? null : never;
}

function looseMetas<K extends Kind>(items: readonly Loose<K>[]): string {
  let out = "";
  for (const item of items) out += `${item.kind}:${JSON.stringify(item.meta)} `;
  return out;
}

function emptyMetas<K extends Kind>(items: readonly Empty<K>[]): string {
  let out = "";
  for (const item of items) {
    // The local holds the member's type, so the `{}` arm's mapping is
    // emitted (a bare read would convert to dyn at the use site).
    const meta = item.meta;
    out += `${item.kind}:${JSON.stringify(meta)} `;
  }
  return out;
}

function unitMetas<K extends Kind>(items: readonly Units<K>[]): string {
  let out = "";
  for (const item of items) {
    const meta = item.meta;
    out += `${item.kind}:${meta === undefined ? "u" : meta === null ? "n" : meta.depth} `;
  }
  return out;
}

const loose: Loose<"alpha" | "beta">[] = [
  { kind: "alpha", meta: "free" },
  { kind: "alpha", meta: [1, 2] },
  { kind: "beta", meta: { depth: 2 } },
];
console.log(looseMetas(loose));

const empty: Empty<"alpha" | "beta">[] = [
  { kind: "alpha", meta: { free: true } },
  { kind: "alpha", meta: "text" },
  { kind: "beta", meta: { depth: 4 } },
];
console.log(emptyMetas(empty));
console.log(JSON.stringify(empty));

const units: Units<"alpha" | "beta" | "gamma">[] = [
  { kind: "alpha", meta: undefined },
  { kind: "beta", meta: { depth: 3 } },
  { kind: "gamma", meta: null },
];
console.log(unitMetas(units));
console.log(JSON.stringify(units));
