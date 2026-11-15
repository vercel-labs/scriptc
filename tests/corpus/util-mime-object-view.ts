// util.MIMEType and util.MIMEParams are ordinary JavaScript objects: their
// getters describe the parsed type, their members read through a checked
// object, and a record shape accepts them the way Node does.
import { MIMEType, MIMEParams, inspect, format } from "node:util";

const mime = new MIMEType("text/plain;charset=utf-8;boundary=a");
const show = (label: string, run: () => unknown): void => {
  try {
    console.log(label, run());
  } catch (e: any) {
    console.log(label, e.name, e.code, e.message);
  }
};

console.log(mime.type, mime.subtype, mime.essence);
console.log(String(mime), mime.toString(), JSON.stringify(mime));
console.log(mime.params === mime.params);
console.log(String(mime.params), mime.params.get("CHARSET"), mime.params.has("nope"));
console.log([...mime.params.keys()].join(","), [...mime.params.values()].join(","));
console.log([...mime.params.entries()].map(([k, v]) => k + "=" + v).join("|"));
mime.params.set("boundary", "b");
mime.params.set("Q", "1");
mime.params.delete("charset");
console.log(String(mime));
console.log([...mime.params].map(([k, v]) => k + "=" + v).join(","));

// A method read without a call is the class's function, and Node's aliases
// share one function: `toJSON` is `toString`, and `Symbol.iterator` is
// `entries`, so iterating through the symbol method runs `entries`.
console.log(mime.toJSON === mime.toString, mime.params.toJSON === mime.params.toString);
console.log(mime.params[Symbol.iterator] === mime.params.entries, mime.params.entries === mime.params.values);
console.log(mime.toJSON.name, mime.params.toJSON.name);
console.log([...mime.params[Symbol.iterator]()].map(([k, v]) => k + "=" + v).join("|"));

// A record shape accepts the handle's own getters and methods.
const typeOf = (value: { type: string; subtype: string; essence: string }): string =>
  value.type + "/" + value.subtype + "=" + value.essence;
console.log(typeOf(mime));
const paramsOf = (value: { params: MIMEParams }): string => value.params.get("q") ?? "none";
console.log(paramsOf(mime));
const anyMime: any = mime;
console.log(anyMime.type, anyMime["essence"], typeof anyMime.params.get);
console.log(mime instanceof MIMEType, mime instanceof MIMEParams, new MIMEParams() instanceof MIMEParams);

// The parse factory answers null for an input it cannot parse.
const parsed = MIMEType.parse("Image/PNG;x=1");
console.log(parsed === null ? "null" : String(parsed));
console.log(MIMEType.parse("not a type") === null, MIMEType.parse("") === null);

// Inspect and format print the handle as its class, as Node does.
console.log(inspect(mime));
console.log(format("%s|%s", mime, new MIMEParams()));
console.log(JSON.stringify([mime, new MIMEParams()]));

// Bad input reports the same errors as Node.
show("bad type", () => new MIMEType("not a type"));
show("object input", () => String(new MIMEType({ toString: () => "a/b;c=d" })));
show("bad name", () => mime.params.set("a b", "c"));
show("bad value", () => mime.params.set("ok", "Ā"));
show("bad type set", () => {
  (mime as any).type = "a b";
  return String(mime);
});
show("bad subtype set", () => {
  (mime as any).subtype = "";
  return String(mime);
});
