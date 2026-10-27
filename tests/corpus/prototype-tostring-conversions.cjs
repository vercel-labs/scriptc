'use strict';
// ToString of objects whose toString or valueOf comes from the object or
// its prototype chain: template literals, join, String(), concatenation,
// Array.prototype.toString and the default sort order call it, as in Node.
function RefNum(num) { this.num = num; }
RefNum.prototype.toString = function () { return "R" + this.num; };
function Inherit() {}
Inherit.prototype = Object.create(RefNum.prototype);
Inherit.prototype.num = 9;

const r = new RefNum(5);
const deep = new Inherit();
const own = { toString() { return "own"; } };
const viaValueOf = { valueOf() { return 42; } };
const both = { toString() { return "ts"; }, valueOf() { return 7; } };
const plain = {};
const m = new Map([[1, r]]);

console.log(`${r}`, `${deep}`, `${own}`, `${viaValueOf}`, `${both}`, `${plain}`);
console.log(`${m.get(1) || 0}`, `${m.get(2) || 0}`, r * 2);
console.log([r, deep, own, both, plain].join("|"));
console.log([r, own].toString(), String([r, own]), `${[r, own]}`);
console.log([[r, [own]], null, undefined, deep].join(";"));
console.log(String(r), r + "", own + "", both + "", viaValueOf + "", "x".concat(r));
console.log([new RefNum(3), new RefNum(1), own, new RefNum(2)].sort().join(","));

// A toString returning an object falls back to valueOf; a null prototype
// leaves neither, which throws.
const objectResult = { toString() { return {}; }, valueOf() { return "vo"; } };
console.log(`${objectResult}`, [objectResult].join());
const bare = Object.create(null);
try { console.log(`${bare}`); } catch (e) { console.log(e.name, e.message); }
try { console.log([bare].join()); } catch (e) { console.log(e.name, e.message); }

// An exception from toString propagates out of each conversion.
const thrower = { toString() { throw new Error("boom"); } };
try { console.log(`${thrower}`); } catch (e) { console.log("template", e.message); }
try { console.log([thrower].join()); } catch (e) { console.log("join", e.message); }
try { console.log(String([thrower])); } catch (e) { console.log("String", e.message); }
try { console.log([new RefNum(1), thrower].sort()); } catch (e) { console.log("sort", e.message); }

// The conversions read the array's length once: elements an element's
// toString appends are not converted, an index it removes reads empty, and
// the first exception ends the conversion before later elements convert.
const growing = [];
growing.push({ toString() { growing.push("late"); return "g"; } }, "b");
console.log(`${growing}`, growing.length);
console.log(growing.join("|"), growing.length);
console.log(String(growing), growing.length);
const shrinking = [];
shrinking.push({ toString() { shrinking.length = 1; return "s"; } }, "gone", "also");
console.log(`${shrinking}`, shrinking.length);
shrinking.push("gone", "also");
console.log(shrinking.join("|"), shrinking.length);
shrinking.push("gone", "also");
console.log(String(shrinking), shrinking.length);
const visited = [];
const stops = [];
stops.push(
  { toString() { throw new Error("first"); } },
  { toString() { visited.push("second"); return "second"; } },
);
try { console.log(`${stops}`); } catch (e) { console.log("template", e.message, visited.length); }
try { console.log(stops.join()); } catch (e) { console.log("join", e.message, visited.length); }
try { console.log(String(stops)); } catch (e) { console.log("String", e.message, visited.length); }
try { console.log(`${[stops]}`); } catch (e) { console.log("nested", e.message, visited.length); }

// A hole reads through the prototype: a getter there that throws ends each
// conversion with its exception.
const holeyProto = Object.create(Array.prototype);
Object.defineProperty(holeyProto, '1', { get() { throw new Error('getter'); } });
const holey = [];
holey[0] = 'a';
holey[2] = 'c';
Object.setPrototypeOf(holey, holeyProto);
try { console.log(String(holey)); } catch (e) { console.log('String', e.message); }
try { console.log(holey.join('|')); } catch (e) { console.log('join', e.message); }
try { console.log(`${holey}`); } catch (e) { console.log('template', e.message); }
