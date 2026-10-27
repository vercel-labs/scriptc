// JavaScript: array destructuring (var, let and const) and `for (var ...
// of ...)` bind the existing element objects of an array built with push,
// so writes through the bindings reach the array's objects.
function destructure() {
  var all = [];
  all.push({ x: 1 });
  all.push({ x: 2 });
  var [first] = all;
  first.x = 10;
  let [, second] = all;
  second.x = 20;
  const [again] = all;
  again.x += 1;
  console.log(JSON.stringify(all), first === all[0], again === first, second === all[1]);
}
destructure();

function forVarOf() {
  var all = [];
  all.push({ x: 1 });
  all.push({ x: 2 });
  var seen = [];
  for (var o of all) {
    o.x *= 10;
    seen.push(o === all[seen.length]);
  }
  console.log(JSON.stringify(all), seen.join());
  for (let p of all) p.x += 1;
  console.log(JSON.stringify(all));
}
forVarOf();

function* tagged(list) {
  for (var o of list) {
    o.seen = true;
    yield o;
  }
}
function generators() {
  var items = [];
  items.push({ seen: false });
  items.push({ seen: false });
  for (var it of tagged(items)) it.extra = items.indexOf(it);
  console.log(JSON.stringify(items));
}
generators();
