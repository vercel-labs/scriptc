// Math.max and Math.min as the only consumers of an untyped generator: the
// spread steps the generator, whose values fold with ToNumber as in Node.
function* generate(limit) {
  for (let i = 1; i <= limit; i++) yield i % 2 === 0 ? String(i * 3) : i;
}
const lookup = { generate };
console.log(Math.max(...lookup.generate(4)), Math.min(...lookup.generate(4)));
console.log(Math.max(...lookup.generate(0)), Math.min(...lookup.generate(1)));
