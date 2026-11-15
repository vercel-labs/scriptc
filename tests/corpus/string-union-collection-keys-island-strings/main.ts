// @requires-libnode
// Strings that come out of a Node island (one-byte strings, lone
// surrogates, decoded bytes, keys, error messages) probed against a Set
// and a Map that hold a unit key; their UTF-8 bytes are printed.
import { oneByte, decoded, lone, pair, keys, list, fail, call, table } from "islandstrings";

const nullSet = new Set<string | null>([null, "plain"]);
const undefSet = new Set<string | undefined>([undefined, "plain"]);
const both = new Map<string | null | undefined, number>([
  [null, 1],
  [undefined, 2],
]);
let hits = 0;
function probe(label: string, s: string): void {
  const hit = nullSet.has(s) || undefSet.has(s) || both.has(s);
  if (hit) hits++;
  const codes: number[] = [];
  for (let i = 0; i < s.length && i < 6; i++) codes.push(s.charCodeAt(i));
  console.log(label, hit ? "HIT" : "ok", s.length, codes.join(","), Buffer.from(s, "utf8").toString("hex"));
}

probe("oneByte n", oneByte("n"));
probe("oneByte u", oneByte("u"));
probe("decoded n", decoded(0x6e));
probe("decoded u", decoded(0x75));
probe("lone", lone());
probe("pair", pair());
for (const key of keys()) probe("key", key);
for (const item of list()) probe("item", item);
try {
  fail();
} catch (err) {
  probe("message", (err as Error).message);
}
call((text) => probe("callback", text));
probe("table", table().get("ÿn") ?? "none");
probe("echo", oneByte("n") + oneByte("u"));
nullSet.add(oneByte("n"));
undefSet.add(oneByte("u"));
console.log("hits", hits, nullSet.size, undefSet.size, nullSet.has(null), undefSet.has(undefined));
