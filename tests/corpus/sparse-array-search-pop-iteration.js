// An array whose length sits far past its dense prefix, seen through the
// searches, pop, iteration and a length shrink. includes compares with
// SameValueZero, so a hole reads as undefined and NaN matches itself, while
// the strict indexOf searches skip holes. pop reads and deletes the last
// index (a hole needs no delete), iteration visits the whole logical length,
// and the length shrink deletes from the highest index down, so a sealed
// element refuses the length at that index + 1.
let a = [];
a[0] = 'x';
a[1000002] = 'z';
console.log('shape', a.length, a[0], a[1], a[1000002]);
console.log('includes', a.includes(undefined), a.includes(undefined, 1), a.includes(NaN), a.includes('z'));
a[1] = NaN;
console.log('nan', a.includes(NaN), a.includes(NaN, 1), a.indexOf(NaN), a.lastIndexOf(NaN));
console.log('strict', a.indexOf(undefined), a.indexOf('z'), a.lastIndexOf('z'));

let b = [];
b[0] = 'x';
b[1000002] = 'z';
console.log('pop', b.pop(), b.length);
console.log('pop-hole', b.pop(), b.length);
console.log('pop-hole-again', b.pop(), b.length);

let c = [];
c[0] = 'x';
c[1000002] = 'z';
Object.seal(c);
try {
  c.pop();
} catch (e) {
  console.log('sealed-pop', e.name, e.message, c.length, c[1000002]);
}
let d = [];
d[0] = 'x';
d[1000002] = 'z';
Object.seal(d);
try {
  d.length = 1;
} catch (e) {
  console.log('sealed-shrink', e.name, e.message, d.length, d[1000002]);
}

let big = [];
big[0] = 0;
big[0] = 'x';
big[1000002] = 'z';
let seen = 0;
let first;
let last;
for (const v of big) {
  if (seen === 0) first = v;
  seen++;
  last = v;
}
console.log('iter', seen, first, last);
console.log('spread', [...big].length);
