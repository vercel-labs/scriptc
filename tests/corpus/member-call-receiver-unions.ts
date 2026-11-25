// A function that reads the receiver of its call, called as a member of a
// union of record shapes, or copied into another member through a literal
// string index: the call passes the holder, as in Node.
function describe(this: unknown, label: string): void {
  const self = this as { tag?: unknown } | undefined;
  console.log(label, this === undefined, typeof this, self === undefined ? "none" : self.tag);
}

interface Small {
  kind: "small";
  tag: string;
  f: (label: string) => void;
}
interface Large {
  kind: "large";
  tag: string;
  f: (label: string) => void;
  size: number;
}
const pick = (large: boolean): Small | Large =>
  large
    ? { kind: "large", tag: "large", f: describe, size: 2 }
    : { kind: "small", tag: "small", f: describe };
pick(false).f("union, small arm");
pick(true).f("union, large arm");
const held: Small | Large = pick(true);
held.f("union binding");

const source = { tag: "source", callback: describe };
const copy = { tag: "copy", run: source["callback"] };
copy.run("copied through a string index");
const copy2 = { tag: "copy2", run: source[`callback`] };
copy2.run("copied through a template index");
