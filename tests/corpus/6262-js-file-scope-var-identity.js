// JavaScript: file-scope `var` and `let` bindings initialized with an
// existing object (an element of an array built with push) hold that
// object, including bindings declared in a loop body, by destructuring or
// by for-of, and functions declared above them read the same object.
function show() {
  return typeof o === "undefined" ? "unset" : o.x;
}
console.log(show());

var all = [];
all.push({ x: 1 });
all.push({ x: 2 });

var o = all[0];
o.x = 10;
console.log(show(), JSON.stringify(all), o === all[0]);

var same = 0;
for (var j = 0; j < all.length; j++) {
  var item = all[j];
  item.x += 5;
  if (item === all[j]) same++;
}
console.log(JSON.stringify(all), same);

var [head] = all;
head.x = 100;
for (var each of all) {
  each.x += 1;
  if (each === all[1]) console.log("last", each.x);
}
console.log(JSON.stringify(all), head === o);

let current = all[1];
current.x = 7;
function touch() {
  current.x++;
}
touch();
console.log(JSON.stringify(all), current === all[1]);
