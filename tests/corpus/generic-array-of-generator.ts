// A generic helper that stores its argument in a `T[]` and reads it back,
// instantiated at types an array cannot hold natively: generators and a
// URLSearchParams. The array becomes a checked-dynamic value and the read
// is a checked cast back to `T`, so the value that comes out is the one
// that went in.
function viaArray<T>(value: T): T {
  const held: T[] = [value];
  return held[0] as T;
}

function* count(from: number): Generator<number> {
  yield from;
  yield from + 1;
}

const original = count(10);
const same = viaArray(original);
console.log(same === original, same.next().value, same.next().value, same.next().done);

function* pairs(): Generator<[string, number]> {
  yield ["a", 1];
  yield ["b", 2];
}
for (const [key, value] of viaArray(pairs())) console.log(key, value);

const params = viaArray(new URLSearchParams("a=1&b=two"));
console.log(params.get("a"), params.get("b"), params.toString());
console.log(viaArray(7), viaArray("text"), viaArray([1, 2]).length);
