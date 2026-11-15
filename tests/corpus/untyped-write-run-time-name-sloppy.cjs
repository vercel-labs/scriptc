// A member written under a run-time name in sloppy-mode code: records
// filled by name as in strict code, and assignments that strict code
// refuses (a frozen object, a read-only member, a member with only a
// getter) are ignored without an error. A class in the program gives the
// writes their class dispatch.
var out = [];
function show(tag, v) {
  out.push(tag + ': ' + JSON.stringify(v) + ' keys ' + Object.keys(v).join(','));
}
function put(target, name, value) {
  try {
    target[name] = value;
    return 'ok';
  } catch (e) {
    return e.name + ': ' + e.message;
  }
}
class Point {
  constructor() {
    this.x = 1;
    this.y = 2;
  }
}
var NAMES = ['id', 'type', 'title', 'body', 'href', 'count', 'items', 'owner', 'state', 'flags', 'extra'];

for (var n of [1, 4, 11]) {
  var r = {};
  for (var k = 0; k < n; k++) r[NAMES[k]] = k;
  show('list ' + n, r);
}
var total = 0;
for (var i = 0; i < 200; i++) {
  var row = {};
  row[NAMES[0]] = i;
  row[NAMES[1 + (i % 2)]] = i;
  row[NAMES[3]] = i;
  row[NAMES[0]] = i + 1;
  total += row.id + Object.keys(row).length;
}
out.push('many total ' + total);

var frozen = Object.freeze({ a: 1 });
out.push('frozen old ' + put(frozen, 'a'.concat(''), 2));
out.push('frozen new ' + put(frozen, NAMES[0], 2));
show('frozen', frozen);

var readOnly = {};
Object.defineProperty(readOnly, 'fixed', { value: 1, writable: false, enumerable: true });
out.push('read-only ' + put(readOnly, 'fix' + 'ed', 2));
show('read-only', readOnly);

var seen = '';
var accessor = {
  get only() {
    return 1;
  },
  set watched(v) {
    seen += v + ';';
  },
};
out.push('getter only ' + put(accessor, 'on' + 'ly', 2));
out.push('setter ' + put(accessor, 'watch' + 'ed', 3));
out.push('seen ' + seen + ' only ' + accessor.only);

var point = new Point();
out.push('instance ' + put(point, 'x'.concat(''), 10) + ' ' + (point.x + point.y));
out.push('null ' + put(null, NAMES[0], 1));

var list = [1, 2];
out.push('array ' + put(list, String(3), 'three') + ' ' + put(list, NAMES[0], 'named') + ' ' + list.length + ' ' + list.id);

for (var line of out) console.log(line);
