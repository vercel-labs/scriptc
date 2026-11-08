// A collection constructor passed an array reads its elements in order, and a
// hole reads through the prototype chain, where an inherited indexed getter
// runs, exactly as Node's array iterator does. The same holds for spread and
// for a destructuring rest, which this program pins beside the constructor.

function sparseSeed(elements, getter) {
  const seed = JSON.parse(elements);
  delete seed[1];
  const proto = Object.create(Array.prototype);
  Object.defineProperty(proto, "1", { configurable: true, get: getter });
  Object.setPrototypeOf(seed, proto);
  return seed;
}

let calls = 0;
const seed = sparseSeed("[10,20,30]", () => {
  calls += 1;
  return 222;
});

// No Set.prototype member is read before this construction, so the constructor
// takes the native bulk path: the seed still answers its hole through the
// prototype chain.
const set = new Set(seed);
console.log("set:", set.size, set.has(222), set.has(20), set.has(undefined));

console.log("spread:", [...seed].join(","));

const [first, ...rest] = seed;
console.log("rest:", first, rest.join(","));

// The map is built from a seed with a hole the same way.
const mapSeed = sparseSeed('[["a",1],["b",2]]', () => ["b", 2]);
const map = new Map(mapSeed);
console.log("map:", map.size, map.get("a"), map.get("b"));

console.log("getter calls:", calls);

// WeakSet and WeakMap read a seed entry the same way.
const keyed = { name: "keyed" };
let weakReads = 0;
const weakSetSeed = sparseSeed('[{"x":1},{"x":2},{"x":3}]', () => {
  weakReads += 1;
  return keyed;
});
const weakSet = new WeakSet(weakSetSeed);
console.log("weak set:", weakSet.has(keyed), weakReads);

const firstKey = { name: "first" };
const middleKey = { name: "middle" };
const lastKey = { name: "last" };
const weakMapSeed = JSON.parse("[0,0,0]");
delete weakMapSeed[1];
weakMapSeed[0] = [firstKey, 1];
weakMapSeed[2] = [lastKey, 3];
const weakMapProto = Object.create(Array.prototype);
Object.defineProperty(weakMapProto, "1", {
  configurable: true,
  get: () => [middleKey, 2],
});
Object.setPrototypeOf(weakMapSeed, weakMapProto);
const weakMap = new WeakMap(weakMapSeed);
console.log("weak map:", weakMap.get(firstKey), weakMap.get(middleKey), weakMap.has(lastKey));
