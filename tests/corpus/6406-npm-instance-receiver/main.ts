// A package's constructor function, compiled per call site, reads its own
// receiver while the constructor that reached it has a receiver too.
import { create } from "corked-writer";
const w = create({ highWaterMark: 4 });
console.log(w.uncork());
console.log(w.uncork());
console.log(create().uncork());
