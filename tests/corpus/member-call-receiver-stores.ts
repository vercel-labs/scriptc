// A function that reads the receiver of its call, stored into a member
// through a parameter it was passed as or under a literal computed key: a
// call of that member passes the holder, as in Node.
function describe(this: unknown, label: string): void {
  const self = this as { tag?: unknown } | undefined;
  console.log(label, this === undefined, typeof this, self === undefined ? "none" : self.tag);
}

// A factory stores its callback parameter in a member.
function make(callback: (label: string) => void): { tag: string; run: (label: string) => void } {
  return { tag: "made", run: callback };
}
const made = make(describe);
made.run("factory member");

function wrap(callback: (label: string) => void): { tag: string; callback: (label: string) => void } {
  return { tag: "shorthand", callback };
}
wrap(describe).callback("shorthand from a parameter");

function attach(
  target: { tag: string; on?: (label: string) => void },
  fn: (label: string) => void,
): void {
  target.on = fn;
}
const target: { tag: string; on?: (label: string) => void } = { tag: "target" };
attach(target, describe);
target.on?.("assigned from a parameter");

// Literal computed property names.
const computed = { tag: "computed", ["make"]: describe };
computed.make("computed string key");
const template = { tag: "template", [`tpl`]: describe };
template.tpl("computed template key");
const numeric = { tag: "numeric", [7]: describe };
numeric[7]("computed numeric key");
