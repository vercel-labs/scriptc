// JavaScript: an object a function returns is the object the function
// holds elsewhere (a cache entry, a registry element). Bindings that
// receive it and array or object literals built from those bindings keep
// that object, so writes through them reach the cache and registry.
'use strict';
const cache = { n: 0 };
function get() {
  return cache;
}

const registry = [];
function make(name) {
  const o = { name: name, hits: 0 };
  registry.push(o);
  return o;
}

function identity(v) {
  return v;
}
function wrapped(i) {
  return identity({ id: i, x: i % 17 });
}

function main() {
  var a = get();
  a.n = 5;
  console.log(cache.n, a === cache);
  var list = [a];
  list[0].n = 6;
  var holder = { item: a };
  holder.item.n += 1;
  console.log(cache.n, list[0] === cache, holder.item === cache);

  var x = make("x");
  let y = make("y");
  const z = make("z");
  x.hits++;
  y.hits += 2;
  z.hits += 3;
  var group = [x, y, z];
  for (var j = 0; j < group.length; j++) group[j].hits *= 10;
  console.log(JSON.stringify(registry), group[0] === registry[0]);

  var all = [];
  for (var i = 0; i < 4; i++) all.push(wrapped(i));
  var sum = 0;
  for (var r = 0; r < 3; r++)
    for (var k = 0; k < all.length; k++) {
      var e = all[k];
      e.x += 1;
      sum += e.x;
    }
  console.log(all.length, sum, JSON.stringify(all.slice(0, 2)));
}
main();
