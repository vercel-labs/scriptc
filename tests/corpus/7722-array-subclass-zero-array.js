// lru-cache's ZeroArray: a JavaScript class extending Array whose
// constructor fills the new array with zeros, constructed directly and
// through map (species construction runs the constructor again).
class ZeroArray extends Array {
  constructor(size) {
    super(size);
    this.fill(0);
  }
}

const z = new ZeroArray(4);
z[1] = 7;
console.log(z, z.length, z instanceof ZeroArray, Array.isArray(z));
const m = z.map((v) => v + 1);
console.log(m, m instanceof ZeroArray);
console.log(z.slice(1) instanceof ZeroArray, String(z));
