// V8 names a callee it could not call the way the running JavaScript
// reads it: parentheses and type-only syntax are gone from the message.
// Each shape below throws a TypeError whose text Node prints from the
// erased expression.

function show(label: string, fn: () => void): void {
  try {
    fn();
    console.log(label, "| called");
  } catch (e: any) {
    console.log(label, "|", e.message);
  }
}

const o: any = {};
const present: any = { answer: () => 42 };

show("receiver cast", () => (o as any).missing());
show("nested cast", () => ((o as any) as any).missing());
show("satisfies", () => (o as any satisfies any).missing());
show("element key", () => (o as any)["missing"]());
show("bracket callee", () => (o["missing"] as any)());
show("callee cast", () => (o.missing as any)());
show("parenthesised", () => (o.missing)());
show("non-null member", () => (o!.missing)());
show("tagged template", () => (o as any).tag`x`);
show("mapped element key", () => {
  const key = "missing";
  (o as any)[key]();
});

// The same spellings call a function when the property exists.
show("present cast", () => console.log((present as any).answer()));
show("present element", () => console.log((present as any)["answer"]()));
show("present bracket callee", () => console.log((present["answer"] as any)()));
