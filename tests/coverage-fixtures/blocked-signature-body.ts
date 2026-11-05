// Functions whose signatures cannot compile: the report still lists what
// their bodies would report. A use of the blocked parameter names the
// declaration; the body's own unsupported statement reports itself, with
// the reached diagnostics for a function the entry calls and as unreached
// for one nothing calls.
function measure(target: Intl.NumberFormat, label: string): number {
  const extra = new Intl.NumberFormat();
  console.log(target);
  return label.length + (extra == undefined ? 0 : 1);
}
function unused(target: Intl.NumberFormat): number {
  const extra = new Intl.NumberFormat();
  return extra == undefined ? 0 : 1;
}
console.log(measure(new Intl.NumberFormat(), "abc"));
// A declared `this` parameter gives the body its receiver.
function described(this: { label: string }, target: Intl.NumberFormat): string {
  return this.label + String(target);
}
