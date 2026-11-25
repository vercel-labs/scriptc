// An encoding argument written as an explicit undefined expression still
// evaluates where JavaScript evaluates it: after the receiver and the
// arguments before it, and before the call. The offset argument observes
// the buffer that the encoding expression mutates, so evaluating the
// encoding first would change both the trace and the offset the write uses.

const target = Buffer.alloc(8);
const seen: string[] = [];

const snapshot = (label: string, b: Buffer): number => {
  seen.push(`${label}:${b.toString("hex")}`);
  return b[0] === 0x41 ? 4 : 0;
};
const blank = (label: string, b: Buffer): void => {
  seen.push(label);
  b.fill(0x41);
};

target.write("bc", snapshot("offset", target), 2, void blank("encoding", target));
console.log("write", seen.join(","), target.toString("hex"));

// A string search normalizes a run-time name after every argument; an
// explicitly undefined one keeps the utf8 default and runs in place.
const hay = Buffer.from("abcb");
const order: string[] = [];
const note = (label: string): void => {
  order.push(label);
};
const receiver = (label: string, b: Buffer): Buffer => {
  order.push(label);
  return b;
};
const offset = (label: string, value: number): number => {
  order.push(label);
  return value;
};
const found = receiver("receiver", hay).indexOf("cb", offset("offset", 0), void note("encoding"));
console.log("indexOf", found, order.join(","));

// Buffer.byteLength evaluates its string before the encoding too.
const lengths: string[] = [];
const text = (label: string): string => {
  lengths.push(label);
  return "héllo";
};
const readName = (label: string): void => {
  lengths.push(label);
};
console.log("byteLength", Buffer.byteLength(text("string"), void readName("encoding")), lengths.join(","));
