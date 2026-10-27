// Hash and Hmac values held in 'unknown' and 'any' slots: update(),
// digest() and Hash's copy() dispatch through the value, update() answers
// the same value, a cast back to Hash or Hmac keeps its identity, and the
// errors after digest() are Node's. An Hmac has no copy().
import { createHash, createHmac, type Hash, type Hmac } from "node:crypto";

function code(run: () => unknown): string {
  try {
    const value = run();
    return typeof value === "string" ? `ok ${value.slice(0, 16)}` : `ok ${typeof value}`;
  } catch (error) {
    const e = error as Error & { code?: string };
    return `${e.name} ${e.code ?? ""} ${e.message}`;
  }
}

function hexOf(value: any): string {
  return value.update("abc").digest("hex");
}

console.log("any param", hexOf(createHash("sha256")));
console.log("any param hmac", hexOf(createHmac("sha256", "key")));

const hash = createHash("sha1");
const held: unknown = hash;
console.log("typeof", typeof held, String(held), Object.prototype.toString.call(held));
console.log("cast keeps identity", (held as Hash) === hash);
const chained: any = held;
console.log("update answers the value", chained.update("a") === chained);
console.log("typed digest after untyped update", hash.digest("hex"));
console.log("digest again", code(() => chained.digest("hex")));
console.log("update after digest", code(() => chained.update("x")));

const values: unknown[] = [createHash("md5"), createHmac("sha512", "k"), createHash("sha256")];
for (const value of values) {
  const v = value as any;
  v.update("one");
  v.update(Buffer.from("two"));
  v.update("74687265", "hex");
  console.log("array", v.digest("base64"));
}

const record: { label: string; hash: unknown } = { label: "rec", hash: createHash("sha384") };
const fromRecord = record.hash as Hash;
fromRecord.update("record");
console.log(record.label, fromRecord.digest("hex").slice(0, 32));

const original: any = createHash("sha256").update("prefix");
const copy = original.copy();
copy.update("-copy");
original.update("-original");
console.log("copy", copy.digest("hex").slice(0, 16), original.digest("hex").slice(0, 16));
console.log("copy is a new value", copy === original);
const shake: any = createHash("shake256");
shake.update("x");
console.log("copy outputLength", shake.copy({ outputLength: 8 }).digest("hex"));
console.log("copy bad outputLength", code(() => shake.copy({ outputLength: -1 })));

const mac: unknown = createHmac("sha256", "secret");
const macAny: any = mac;
console.log("hmac copy", typeof macAny.copy, macAny.copy === undefined);
console.log("hmac copy call", code(() => macAny.copy()));
console.log("hmac digest", (mac as Hmac).update("data").digest("hex").slice(0, 16));
console.log("hmac digest again", JSON.stringify(macAny.digest("hex")));

console.log("missing member", macAny.nope, typeof chained.missing);
console.log("bad data", code(() => (createHash("sha256") as any).update(42)));
console.log("default digest", (createHash("md5") as any).update("z").digest().length);
