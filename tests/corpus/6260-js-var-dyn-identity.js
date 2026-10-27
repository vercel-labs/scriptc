// JavaScript: a function-scoped `var` initialized with an object that
// already exists (an element of an array built with push, a find result,
// a member of another object) holds that object, not a copy: writes
// through the binding are visible through the array, and `===` holds.
function make(i) {
  return { id: i, x: i % 17 };
}

function updateInPlace() {
  var all = [];
  for (var i = 0; i < 3; i++) all.push(make(i));
  var same = 0;
  for (var j = 0; j < all.length; j++) {
    var o = all[j];
    o.x += 1;
    if (o === all[j]) same++;
  }
  console.log(JSON.stringify(all), same);
}
updateInPlace();

function literalElements() {
  var all = [];
  for (var i = 0; i < 3; i++) all.push({ id: i, x: i });
  for (var j = 0; j < all.length; j++) {
    var o = all[j];
    o.x *= 10;
  }
  console.log(JSON.stringify(all));
}
literalElements();

function initializerForms(flag) {
  var all = [];
  all.push({ n: 0, inner: { v: 1 } });
  all.push({ n: 1, inner: { v: 2 } });
  var found = all.find(function (e) {
    return e.n === 1;
  });
  found.n = 11;
  var picked = flag ? all[0] : null;
  picked.n = 10;
  var either = all[5] || all[0];
  either.inner.v += 100;
  var inner = all[1].inner;
  inner.v = 20;
  var last = all.pop();
  console.log(JSON.stringify(all), last === found, picked === either);
  console.log(JSON.stringify(last));
}
initializerForms(true);

function arraysAndClosures() {
  var grid = [];
  grid.push([1, 2]);
  var row = grid[0];
  row[0] = 9;
  row.push(3);
  var list = [];
  list.push({ count: 0 });
  var target = list[0];
  var bump = function () {
    target.count++;
  };
  bump();
  bump();
  console.log(JSON.stringify(grid), JSON.stringify(list), target === list[0]);
}
arraysAndClosures();

function redeclaredAndReassigned() {
  var all = [];
  all.push({ x: 1 });
  all.push({ x: 2 });
  var o = all[0];
  o.x = 10;
  var o = all[1];
  o.x = 20;
  o = { x: 30 };
  all.push(o);
  o.x = 40;
  console.log(JSON.stringify(all), o === all[2]);
}
redeclaredAndReassigned();

const arrow = () => {
  var all = [];
  all.push({ x: 1 });
  var o = all[0];
  o.x = 5;
  console.log(JSON.stringify(all));
};
arrow();

// An annotated binding keeps its declared type.
function annotated() {
  var all = [];
  all.push({ x: 1 });
  /** @type {{ x: number }} */
  var o = all[0];
  console.log(o.x);
}
annotated();
