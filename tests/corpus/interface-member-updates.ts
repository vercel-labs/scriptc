// Compound assignments and updates of a member through an interface.
interface Shape { scale: number; area(): number }
class Sq implements Shape { scale = 1; area(): number { return 4 * this.scale; } }
class Ci implements Shape { scale = 2; area(): number { return 3 * this.scale; } }
function mk(i: number): Shape { return i % 2 === 0 ? new Sq() : new Ci(); }
const a = mk(0), b = mk(1);
a.scale += 2; b.scale++; a.scale *= 2; b.scale -= 1; --a.scale;
console.log(a.scale, b.scale, a.area(), b.area());
