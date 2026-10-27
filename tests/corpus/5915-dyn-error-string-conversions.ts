// Errors held as `any` convert to strings through Error.prototype.toString
// in every dynamic conversion: template literals, `+` with a string on
// either side, String(), Array join, loose equality, Number() and property
// keys. The name is read through the prototype ("Error", "TypeError", a
// subclass's own name), an empty name or message leaves the other alone,
// and a subclass without its own name inherits "Error".

class NamedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NamedError";
  }
}

class PlainSubclass extends Error {}

function show(label: string, error: any): void {
  console.log(label, "|", `${error}`, "|", "" + error, "|", error + "!", "|", String(error), "|", [error, 1].join(" "));
}

show("error", new Error("plain"));
show("type", new TypeError("bad thing"));
show("range", new RangeError("too far"));
show("syntax", new SyntaxError("unexpected"));
show("named", new NamedError("mine"));
show("subclass", new PlainSubclass("inherited name"));
show("empty message", new TypeError(""));
show("no message", new Error());

const renamed: any = new Error("message only");
renamed.name = "";
show("empty name", renamed);

const changed: any = new RangeError("before");
changed.message = "after";
show("changed message", changed);

const numeric: any = new Error("42");
numeric.name = "";
const unnumbered: any = new TypeError("x");
console.log("Number", Number(numeric), Number(unnumbered), +numeric);

const type: any = new TypeError("bad thing");
console.log("loose equality", type == "TypeError: bad thing", type == "bad thing");

const keyed: any = {};
keyed[type] = 1;
console.log("key", Object.keys(keyed).join(","));
