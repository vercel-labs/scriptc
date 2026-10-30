// Printing u8 byte views whose static type does not say what they are:
// union arms, elements and fields print as Node does by the value's kind.
type UintArray = Uint8Array | Uint16Array | Uint32Array;
const mk = (n: number): UintArray => (n > 1 ? new Uint16Array([1, 700]) : new Uint8Array([1, 188]));
const a = mk(1), b = mk(2);
console.log(a, b);
console.log([a, b]);
const bufArm: Uint8Array | Uint16Array = Buffer.from([1, 2, 3]);
console.log(bufArm);
const u8s: Uint8Array[] = [new Uint8Array([9]), Buffer.from([10, 11])];
console.log(u8s);
const rec: { bytes: Uint8Array; view: DataView } = { bytes: new Uint8Array(2), view: new DataView(new ArrayBuffer(2)) };
console.log(rec);
console.log(new Uint8Array([5, 6]), Buffer.from([7]));
