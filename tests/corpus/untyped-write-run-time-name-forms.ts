export {};
// A member written under a name known only at run time (`record[name] =
// value`) into an untyped value: fresh records filled member by member as a
// decoder fills them (names from a list, from slices of a text, from the
// keys of a parsed object, from a for-in), the same names over many
// records, two shapes that share a prefix, overwrites, names that spell
// numbers, names of Object.prototype's members, and receivers that are not
// plain records (an accessor, a frozen, sealed or non-extensible object, an
// object with a prototype, an array, a class instance, a function, an
// Error, a primitive). The same writes with the name in the source stand
// beside them.
type Rec = { [key: string]: unknown };
const out: string[] = [];
function text(v: unknown): string {
  if (typeof v === 'function') return 'function';
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v) ?? String(v);
  } catch (e) {
    return 'throws ' + String(e);
  }
}
function show(tag: string, v: unknown): void {
  const keys = v !== null && typeof v === 'object' ? ' keys ' + Object.keys(v).join(',') : '';
  out.push(tag + ': ' + text(v) + keys);
}
function put(target: any, name: string, value: unknown): string {
  try {
    target[name] = value;
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.name + ': ' + e.message : String(e);
  }
}
function get(target: any, name: string): unknown {
  return target[name];
}

const NAMES: string[] = [
  'id', 'type', 'title', 'body', 'href', 'count', 'items', 'owner', 'state', 'flags', 'extra',
];
const WIDE: string[] = [];
for (let i = 0; i < 40; i++) WIDE.push('k' + i);
const TEXT =
  '{"id":1,"type":"card","title":"t","body":"b","href":"h","count":7,"items":[1,2],"owner":null,"state":true,"flags":0,"extra":"x"}';
const PARSED: Rec = JSON.parse(TEXT);
const VALUES: unknown[] = [];
for (let i = 0; i < 40; i++) VALUES.push(i % 4 === 0 ? 'v' + i : i % 4 === 1 ? i : i % 4 === 2 ? i % 8 === 2 : [i]);

// Fresh records of 1, 4, 11 and 40 members, names from a list.
for (const n of [1, 4, 11]) {
  const r: Rec = {};
  for (let k = 0; k < n; k++) r[NAMES[k]] = VALUES[k];
  show('list ' + n, r);
}
{
  const r: Rec = {};
  for (let k = 0; k < 40; k++) r[WIDE[k]] = VALUES[k];
  show('list 40', r);
  // overwrite every member of a wide record, last to first
  for (let k = 39; k >= 0; k--) r[WIDE[k]] = k;
  show('wide overwritten', r);
  out.push('wide read ' + text(r.k0) + ' ' + text(r.k39) + ' ' + text(r['k' + 17]));
}

// Names that are fresh strings: slices of a text.
{
  const r: Rec = {};
  for (const name of NAMES) {
    const at = TEXT.indexOf('"' + name + '"') + 1;
    r[TEXT.slice(at, at + name.length)] = name.length;
  }
  show('slices', r);
}

// Names from the keys of a parsed object, and from a for-in over it.
{
  const r: Rec = {};
  const keys = Object.keys(PARSED);
  for (let k = 0; k < keys.length; k++) r[keys[k]] = k;
  show('parsed keys', r);
  const copy: Rec = {};
  for (const name in PARSED) copy[name] = PARSED[name];
  show('for-in copy', copy);
  out.push('copy equals source: ' + String(JSON.stringify(copy) === JSON.stringify(PARSED)));
  // a write into a parsed object itself: a new member and an old one
  const parsed: Rec = JSON.parse('{"a":1,"b":[2]}');
  parsed[NAMES[0]] = 'new';
  parsed['a'.concat('')] = { nested: true };
  show('parsed written', parsed);
}

// The same names over many records, and two shapes that share a prefix.
{
  let total = 0;
  const kept: Rec[] = [];
  for (let i = 0; i < 300; i++) {
    const r: Rec = {};
    r[NAMES[0]] = i;
    r[NAMES[1]] = 'row';
    r[NAMES[2 + (i % 2)]] = i * 2;
    r[NAMES[4]] = i % 3 === 0;
    kept.push(r);
  }
  for (const r of kept) {
    const id = r.id;
    const third = r.title ?? r.body;
    if (typeof id === 'number' && typeof third === 'number') total += id + third;
  }
  out.push('many total ' + total);
  show('many first', kept[0]);
  show('many second', kept[1]);
  show('many last', kept[299]);
}

// Overwrites: the value replaces, the position stays.
{
  const r: Rec = {};
  for (let k = 0; k < 4; k++) r[NAMES[k]] = k;
  for (let k = 3; k >= 0; k--) r[NAMES[k]] = 'again ' + k;
  r[NAMES[1]] = undefined;
  r[NAMES[2]] = null;
  show('overwritten', r);
  out.push('has type ' + String('type' in r) + ' ' + String(r.type === undefined));
  // by name, then by source name, then by name again
  r.title = 'static';
  r[NAMES[2]] = 'dynamic';
  out.push('title ' + text(r.title));
  // the record written into itself
  r[NAMES[0]] = r;
  out.push('self ' + String(r.id === r));
  r[NAMES[0]] = 0;
}

// Names that spell numbers: integer keys first in ascending order, then
// the others in insertion order.
{
  const numeric = ['12', '0', '7', 'b', '100', 'a', '1.5', '-1', '01', '4294967294', '4294967295', ''];
  const r: Rec = {};
  for (let k = 0; k < numeric.length; k++) r[numeric[k]] = k;
  show('numeric', r);
  const s: Rec = {};
  s['b'] = 1;
  s[String(2)] = 2;
  s[String(1)] = 3;
  s['a'] = 4;
  show('numeric static beside', s);
  let order = '';
  for (const name in r) order += name + '|';
  out.push('numeric for-in ' + order);
}

// Names of Object.prototype's members become own members.
{
  const members = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];
  const r: Rec = {};
  for (let k = 0; k < members.length; k++) r[members[k]] = k;
  show('prototype names', r);
  out.push('own toString ' + String(Object.prototype.hasOwnProperty.call(r, 'toString')));
  const untouched: Rec = {};
  out.push('other record keeps its toString: ' + typeof untouched.toString);
}

// Receivers that are not plain records.
{
  let seen = '';
  const accessor: Rec = {
    plain: 0,
    get watched(): unknown {
      return 'got';
    },
    set watched(v: unknown) {
      seen += text(v) + ';';
    },
    get readOnly(): unknown {
      return 1;
    },
  };
  out.push('setter ' + put(accessor, NAMES[2].replace('title', 'watched'), 5));
  out.push('setter again ' + put(accessor, 'watch' + 'ed', 'six'));
  out.push('getter only ' + put(accessor, 'read' + 'Only', 2).slice(0, 9));
  out.push('plain beside ' + put(accessor, 'pla' + 'in', 7));
  out.push('new beside ' + put(accessor, NAMES[0], 8));
  show('accessor object', accessor);
  out.push('seen ' + seen);

  const frozen: Rec = { a: 1 };
  Object.freeze(frozen);
  out.push('frozen old ' + put(frozen, 'a'.concat(''), 2));
  out.push('frozen new ' + put(frozen, NAMES[0], 2));
  show('frozen', frozen);

  const sealed: Rec = { a: 1 };
  Object.seal(sealed);
  out.push('sealed old ' + put(sealed, 'a'.concat(''), 2));
  out.push('sealed new ' + put(sealed, NAMES[0], 2));
  show('sealed', sealed);

  const closed: Rec = { a: 1 };
  Object.preventExtensions(closed);
  out.push('closed old ' + put(closed, 'a'.concat(''), 2));
  out.push('closed new ' + put(closed, NAMES[0], 2));
  show('closed', closed);

  const readOnly: Rec = {};
  Object.defineProperty(readOnly, 'fixed', { value: 1, writable: false, enumerable: true });
  out.push('read-only ' + put(readOnly, 'fix' + 'ed', 2));
  out.push('read-only other ' + put(readOnly, NAMES[1], 2));
  show('read-only', readOnly);

  const deleted: Rec = {};
  for (let k = 0; k < 4; k++) deleted[NAMES[k]] = k;
  delete deleted.type;
  deleted[NAMES[1]] = 'back';
  deleted[NAMES[5]] = 'more';
  show('deleted then written', deleted);

  let protoSeen = '';
  const proto: Rec = {
    inherited: 1,
    set trap(v: unknown) {
      protoSeen += text(v) + ';';
    },
  };
  Object.defineProperty(proto, 'locked', { value: 1, writable: false });
  const child: Rec = Object.create(proto);
  out.push('child inherited ' + put(child, 'inherit' + 'ed', 2));
  out.push('child trap ' + put(child, 'tr' + 'ap', 3));
  out.push('child locked ' + put(child, 'lock' + 'ed', 4));
  out.push('child new ' + put(child, NAMES[0], 5));
  show('child', child);
  out.push('proto after ' + text(proto.inherited) + ' seen ' + protoSeen);

  const bare: Rec = Object.create(null);
  for (let k = 0; k < 3; k++) bare[NAMES[k]] = k;
  bare['toString'.concat('')] = 'own';
  show('null prototype', bare);

  const list: unknown[] = [1, 2];
  out.push('array index ' + put(list, String(0), 'zero'));
  out.push('array far ' + put(list, String(4), 'four'));
  out.push('array name ' + put(list, NAMES[0], 'named'));
  out.push('array length ' + put(list, 'len' + 'gth', 3));
  show('array', list);
  out.push('array named member ' + text(get(list, NAMES[0])) + ' length ' + list.length);

  class Point {
    x = 1;
    y = 2;
  }
  const point = new Point();
  out.push('instance field ' + put(point, 'x'.concat(''), 10));
  out.push('instance other field ' + put(point, 'y'.concat(''), 20));
  out.push('instance sum ' + (point.x + point.y));

  const fn = function named(): number {
    return 1;
  };
  out.push('function member ' + put(fn, NAMES[0], 'f'));
  out.push('function read ' + text(get(fn, NAMES[0])));

  out.push('number ' + put(5, NAMES[0], 1));
  out.push('string ' + put('abc', NAMES[0], 1));
  out.push('null ' + put(null, NAMES[0], 1));
  out.push('undefined ' + put(undefined, NAMES[0], 1));

  const sym = Symbol('s');
  const withSymbol: any = {};
  withSymbol[sym] = 1;
  withSymbol[NAMES[0]] = 2;
  out.push('symbol beside ' + text(withSymbol[sym]) + ' ' + text(withSymbol.id) + ' ' + Object.keys(withSymbol).join(','));
}

// The names an Error keeps in step with its fields, on a plain record
// before and after an Error has been seen as an untyped value, and on the
// Error itself.
{
  const errorNames = ['name', 'message', 'stack', 'cause', 'code'];
  const before: Rec = {};
  for (let k = 0; k < errorNames.length; k++) before[errorNames[k]] = k;
  show('error names before', before);
  let caught: unknown = null;
  try {
    throw new RangeError('first');
  } catch (e) {
    caught = e;
  }
  const after: Rec = {};
  for (let k = 0; k < errorNames.length; k++) after[errorNames[k]] = k;
  show('error names after', after);
  out.push('error message ' + put(caught, errorNames[1], 'second'));
  out.push('error name ' + put(caught, errorNames[0], 'Renamed'));
  out.push('error code ' + put(caught, errorNames[4], 'E_CODE'));
  out.push('error cause ' + put(caught, errorNames[3], after));
  out.push('error other ' + put(caught, NAMES[0], 9));
  if (caught instanceof Error) {
    out.push('error now ' + String(caught) + ' ' + caught.message + ' ' + caught.name);
    out.push('error code read ' + text(get(caught, errorNames[4])) + ' cause ' + text(get(caught, errorNames[3]) === after));
    out.push('error other read ' + text(get(caught, NAMES[0])));
  }
}

for (const line of out) console.log(line);
