import { Box, Tagged, Leaf, touches } from "./shapes.mjs";

export function read(b) {
  return `size=${b.size} label=${b.label} only=${b.only} ${"size" in b} ${"label" in b}`;
}

export function write(b, value) {
  b.label = value;
  b.only = "x";
  return b.title;
}

export function tagged(t) {
  return `${t.tagged} size=${t.size} name=${t.name}`;
}

export function classes(v) {
  return `${v instanceof Box} ${v instanceof Tagged} ${v instanceof Leaf}`;
}

export function inherited(b) {
  return `${b.toString} ${"toString" in b}`;
}

export function counted(b) {
  const before = touches;
  const value = b.counted;
  return `${before} ${value} ${touches}`;
}

export function own(b) {
  return `${Object.keys(b).join(",")} ${Object.hasOwn(b, "name")} ${JSON.stringify(b)}`;
}
