import { Base, Mid, Leaf } from "./classes.ts";

export function probe(value) {
  const extra = typeof value.extra === "function" ? value.extra() : "none";
  return [
    value.hello(),
    typeof value.extra,
    "extra" in value,
    String(value.mid),
    String(value.leaf),
    extra,
    `${value instanceof Base} ${value instanceof Mid} ${value instanceof Leaf}`,
  ].join(" ");
}

export function kind(value) {
  if (typeof value.extra === "function") return "has-extra";
  return "base-only";
}
