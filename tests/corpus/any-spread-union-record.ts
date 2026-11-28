// A spread literal over an `any` source returned where a union of records is
// expected: the object Node builds is checked against the union's arms.
// Differentially vs Node.
interface Opened {
  kind: "open";
  handle: number;
}
interface Closed {
  kind: "close";
  reason?: string;
}
function reply(source: unknown): Opened | Closed {
  return { ...(source as any) };
}
console.log(JSON.stringify(reply({ kind: "open", handle: 7 })));
console.log(JSON.stringify(reply({ kind: "close", reason: "done" })));
console.log(JSON.stringify(reply({ kind: "close" })));
