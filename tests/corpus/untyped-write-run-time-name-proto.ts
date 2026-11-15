export {};
// `__proto__` written under a name known only at run time: on a plain
// record it is Object.prototype's setter (the prototype changes, no member
// is added, a primitive other than null is ignored); on a record without a
// prototype, or one that owns a member of that name, it is a data member.
// Records filled by run-time names stand beside it, since a program that
// spells `__proto__` runs on the JavaScript object model build.
type Rec = { [key: string]: unknown };
const out: string[] = [];
function show(tag: string, v: Rec): void {
  let inherited = '';
  for (const name in v) inherited += name + '|';
  out.push(tag + ': ' + JSON.stringify(v) + ' keys ' + Object.keys(v).join(',') + ' for-in ' + inherited);
}
function put(target: any, name: string, value: unknown): string {
  try {
    target[name] = value;
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.name + ': ' + e.message : String(e);
  }
}
const NAMES: string[] = ['__proto__', 'plain', 'other', 'constructor'];
const BASE: Rec = { inherited: 7 };

{
  const r: Rec = {};
  r[NAMES[1]] = 1;
  r[NAMES[0]] = BASE;
  r[NAMES[2]] = 2;
  show('setter by name', r);
  out.push('prototype is base: ' + String(Object.getPrototypeOf(r) === BASE) + ' inherited ' + String(r.inherited));
  r[NAMES[0]] = 5;
  out.push('number ignored: ' + String(Object.getPrototypeOf(r) === BASE));
  r[NAMES[0]] = null;
  out.push('null clears: ' + String(Object.getPrototypeOf(r) === null) + ' inherited ' + String(r.inherited));
  r[NAMES[0]] = BASE;
  out.push('own member now: ' + String(Object.keys(r).join(',')) + ' prototype stays null: ' + String(Object.getPrototypeOf(r) === null));
}
{
  const r: any = {};
  r.plain = 1;
  r.__proto__ = BASE;
  r.other = 2;
  show('setter by source name', r);
  out.push('prototype is base: ' + String(Object.getPrototypeOf(r) === BASE));
}
{
  const bare: Rec = Object.create(null);
  bare[NAMES[1]] = 1;
  bare[NAMES[0]] = BASE;
  show('null prototype', bare);
  out.push('still no prototype: ' + String(Object.getPrototypeOf(bare) === null));
}
{
  const own: Rec = { ['__proto__']: 1, plain: 2 };
  own[NAMES[0]] = BASE;
  own[NAMES[2]] = 3;
  show('own member', own);
  out.push('prototype untouched: ' + String(Object.getPrototypeOf(own) === Object.prototype));
}
{
  // a cycle is refused
  const a: Rec = {};
  const b: Rec = {};
  out.push('chain: ' + put(a, NAMES[0], b));
  out.push('cycle: ' + put(b, NAMES[0], a));
}
{
  // many records, the prototype set by name in the middle of the fill
  let total = 0;
  for (let i = 0; i < 200; i++) {
    const r: Rec = {};
    r[NAMES[1]] = i;
    if (i % 2 === 0) r[NAMES[0]] = BASE;
    r[NAMES[2]] = i;
    r[NAMES[3]] = i;
    const inherited = r.inherited;
    total += Object.keys(r).length + (typeof inherited === 'number' ? inherited : 0);
  }
  out.push('many total ' + total);
}
{
  const list: unknown[] = [1];
  out.push('array: ' + put(list, NAMES[0], BASE) + ' ' + String(Object.getPrototypeOf(list) === BASE) + ' ' + String(Array.isArray(list)));
}

for (const line of out) console.log(line);
