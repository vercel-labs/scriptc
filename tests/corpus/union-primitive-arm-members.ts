// Member reads on a union whose STORED value still carries a scalar
// primitive arm that flow analysis removed. JS boxes the primitive, finds
// no such property, and answers undefined — the same answer an absent
// record field gives — so a read through the optional chain is defined
// for every stored arm. Both directions print, so the differential run
// pins the record arm's real value and the primitive arm's undefined.

type Negotiation = { parsed: number; sequence: string } | "pending" | undefined;

interface MessagePart {
  image_url?: string | { url?: string };
}

function pickUrl(part: MessagePart): string {
  const url =
    typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
  return url === undefined ? "<none>" : url;
}

function sequenceOf(n: Negotiation): string {
  if (typeof n === "string") return `pending-literal ${n}`;
  const s = n?.sequence;
  return s === undefined ? "<absent>" : `${n?.parsed}:${s}`;
}

console.log(pickUrl({ image_url: "data:text/plain;base64,AA==" }));
console.log(pickUrl({ image_url: { url: "https://example.test/a.png" } }));
console.log(pickUrl({ image_url: {} }));
console.log(pickUrl({}));

console.log(sequenceOf({ parsed: 3, sequence: "kitty" }));
console.log(sequenceOf("pending"));
console.log(sequenceOf(undefined));

// The same shape through a `typeof` guard and a different field: the
// stored union is the declared one even though the checker removed the
// literal arm, so the primitive arm answers undefined again.
function parsedOrNone(n: Negotiation): number | undefined {
  if (typeof n === "string") return undefined;
  return n?.parsed;
}

console.log(parsedOrNone("pending"));
console.log(parsedOrNone({ parsed: 2, sequence: "x" }));
console.log(parsedOrNone(undefined));

// A number arm beside a record arm: a plain (non-optional) read whose
// stored union still carries the number arm answers undefined for the
// record's field, and the guard in the caller never sees it.
type Counted = { total: number } | number;

function totalOrUndefined(c: Counted): number | undefined {
  if (typeof c === "number") return undefined;
  return c.total;
}

console.log(totalOrUndefined({ total: 9 }));
console.log(totalOrUndefined(42));
