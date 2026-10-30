// Localized failure, stage L2: reference cycles through dynamic slots are
// collected (instance -> dynamic field -> capsule -> instance).
type Peer = Link | Map<string, (x: number) => string> | AbortSignal | (() => number);

class Link {
  id: number;
  peer: Peer | undefined;
  constructor(id: number) {
    this.id = id;
    this.peer = undefined;
  }
  peerId(): number {
    const p = this.peer;
    return p instanceof Link ? p.id : -1;
  }
}

let total = 0;
for (let i = 0; i < 20000; i++) {
  const a = new Link(i);
  const b = new Link(i + 1);
  a.peer = b;
  b.peer = a;
  total += a.peerId() - b.peerId();
}
const keep = new Link(7);
keep.peer = () => keep.id * 2;
const f = keep.peer;
console.log(total, typeof f === "function" ? f() : 0, keep.peerId());
