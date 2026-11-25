// Functions whose signatures cannot compile: the report still lists what
// their bodies would report. A use of the blocked parameter names the
// declaration; the body's own unsupported statement reports itself, with
// the reached diagnostics for a function the entry calls and as unreached
// for one nothing calls.
function measure(target: BigInt64Array<ArrayBuffer>, label: string): number {
  const extra = new BigInt64Array(8);
  console.log(target);
  return label.length + (extra === undefined ? 0 : 1);
}
function unused(target: BigInt64Array<ArrayBuffer>): number {
  const extra = new BigInt64Array(8);
  return extra === undefined ? 0 : 1;
}
console.log(measure(new BigInt64Array(8), "abc"));
// A declared `this` parameter gives the body its receiver.
function described(this: { label: string }, target: BigInt64Array<ArrayBuffer>): string {
  return this.label + String(target);
}
