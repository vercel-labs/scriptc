// A member read on a package-declared data shape. typedbag ships declarations
// only; the interface extends a stdlib type, so the value sits at the
// checked-dynamic tier and `params` reads off it. No package implementation is
// involved, so the read must not be refused as an npm boundary crossing.
import type { TypedBag } from "typedbag";

function parse(raw: string): TypedBag<{ id: string }> {
  return JSON.parse(raw);
}

console.log(parse('{"params":{"id":"42"},"url":"/users/42"}').params.id);
