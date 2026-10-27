// .toString() on a flow-narrowed union whose storage union is wider: the
// read retags to the proven arms, then formats like String().
import type { OutgoingHttpHeaders } from "node:http";

function host(headers?: OutgoingHttpHeaders): string {
  if (headers?.host && !Array.isArray(headers.host)) return headers.host.toString();
  return "";
}
console.log(JSON.stringify([host({ host: "a:1" }), host({ host: 3 }), host({}), host()]));

function label(v: string | number | string[] | undefined): string {
  if (v === undefined) return "none";
  if (Array.isArray(v)) return `list(${v.length})`;
  return v.toString();
}
console.log(label("x"), label(1.5), label(-0), label(["a", "b"]), label(undefined));

function flag(v: boolean | number | null): string {
  return v === null ? "null" : v.toString();
}
console.log(flag(true), flag(false), flag(1e21), flag(null));

type Field = string | number | { nested: string };
function field(f: Field): string {
  return typeof f === "object" ? f.nested : f.toString();
}
console.log(field("s"), field(42), field({ nested: "n" }));
