import { Base, labelled, make, wrap } from "./base.ts";

const V = wrap(Base);
class X extends V {
  own: number = 3;
}
console.log(new X().v + new X().own);
console.log("flag", V.flagged, new X().extra, new X().describe());

// Direct construction through the binding: the value is the call site's
// class, so its constructor carries the statics the call statement ran.
const direct = new V();
console.log("direct", direct.v, direct.extra, (direct.constructor as any).flagged);

// A second call site is a distinct class with its own statics.
const W = wrap(Base);
console.log("fresh", W !== V, W.flagged, V.flagged);

const L = labelled(Base);
class Y extends L {}
const made = new Y();
console.log("label", L.label, L.shout, made.extra, made instanceof Base, made.describe());

const items = [make()];
const first = items[0];
console.log("box", first ? first.v : 0);
