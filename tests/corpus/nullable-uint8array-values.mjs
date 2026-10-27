// Uint8Array | null / undefined values: storage, truthiness, identity, and
// conversion to and from untyped values.
let view = null;
const log = [];
function take(v) { return v; }
for (let i = 0; i < 4; i++) {
  if (view === null) view = new Uint8Array(4);
  view[i] = i * 3;
  log.push(view ? view.length : -1, view === take(view));
  if (i === 2) view = null;
}
let maybe = Math.random() > 2 ? new Uint8Array(1) : undefined;
log.push(maybe === undefined, typeof maybe, !maybe);
maybe = new Uint8Array([5, 6]);
const arr = [maybe, null, new Uint8Array(0)];
log.push(arr.map((x) => (x ? x.length : "none")).join("/"), maybe.subarray(1)[0]);
const m = new Map([[1, maybe]]);
log.push(m.get(1) === maybe);
console.log(log.join(","));
