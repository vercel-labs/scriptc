// An own property written through a compiled Error subclass keeps Node's
// answers: such an error is presented as a checked-dynamic view, and that
// view is where its own properties live, so a refresh from the native slots
// (the class fields, the built-in error slots) must not drop a key the
// native storage cannot hold. Reads, `in` and hasOwnProperty all answer from
// the view. Object.defineProperty and `delete` on such a receiver stay
// refusals (SC2020), so this program only pins the plain write.
class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const e = new HttpError("boom", 500) as Error & { headers?: string };
e.headers = "h";
console.log("error own", Object.prototype.hasOwnProperty.call(e, "headers"));
console.log("error read", e.headers);
console.log("error in", "headers" in e);
console.log("error fields", e.message, e.name, (e as HttpError).status);

// A second write replaces the first, and the property is the same through
// another binding and another dynamic view of the same error.
e.headers = "h2";
const alias = e as HttpError & { headers?: string };
const dyn: any = e;
console.log(
  "error twice",
  alias.headers,
  dyn.headers,
  Object.prototype.hasOwnProperty.call(alias, "headers"),
);

// The expando sits beside the fields that do have native storage: writing
// them keeps working, and keeps the expando.
alias.status = 503;
(alias as Error).message = "changed";
console.log("error mix", alias.status, alias.message, alias.headers, "headers" in alias);

// Through a throw and a typed catch, the own property is on the caught
// error, as in Node.
function fail(): never {
  const err = new HttpError("thrown", 404) as Error & { detail?: string };
  err.detail = "missing";
  throw err;
}
try {
  fail();
} catch (caught) {
  const err = caught as Error & { detail?: string };
  console.log(
    "caught",
    Object.prototype.hasOwnProperty.call(err, "detail"),
    err.detail,
    "detail" in err,
  );
}

// A bare Error keeps it too, and so does a plain compiled class.
const plain = new Error("p") as Error & { tag?: string };
plain.tag = "t";
console.log("plain", Object.prototype.hasOwnProperty.call(plain, "tag"), plain.tag, "tag" in plain);

class Box {
  label = "box";
}
const box = new Box() as Box & { extra?: string };
box.extra = "e";
console.log("class", Object.prototype.hasOwnProperty.call(box, "extra"), box.extra, box.label);

// A Date subclass keeps it.
class Stamp extends Date {}
const stamp = new Stamp(0) as Stamp & { zone?: string };
stamp.zone = "UTC";
console.log("date", Object.prototype.hasOwnProperty.call(stamp, "zone"), stamp.zone);

// An Array subclass keeps a named property too; it follows the elements and
// the class fields in Object.keys order, as it does in Node.
class Row extends Array<number> {
  label = "row";
}
const row = new Row() as Row & { tag?: string };
row.push(1, 2);
row.tag = "r";
console.log("array", Object.prototype.hasOwnProperty.call(row, "tag"), row.tag, "tag" in row);
console.log("array keys", JSON.stringify(Object.keys(row)));
