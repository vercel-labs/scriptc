// Sparse array writes: an index far past the end grows the length without
// materializing the holes between, reads of the holes answer undefined, and
// length assignments and the search methods' bounds see the length the
// program built. Mirrors Test262's S15.4.5.2_A1_T1, S15.4_A1.1_T10, the
// indexOf/lastIndexOf fromIndex-Infinity tests and sm/Array's
// length-truncate-with-indexed. The searches pass a bound so Node does not
// walk the hole range itself.
let x = [];
console.log('empty', x.length);

x[2147483648] = 'far';
console.log('far', x.length, x[2147483648], x[0], x[2147483647]);

x[4294967294] = 'last';
console.log('last', x.length, x[4294967294]);
console.log('holes', 0 in x, 2147483648 in x, 'far' in x);
console.log('fromIndex', x.indexOf('far', Infinity), x.lastIndexOf('last', Infinity));
console.log('lastIndexOf-far', x.lastIndexOf('far', 2147483648), x.lastIndexOf('far', 2147483647));

// A dense prefix plus one far element, then a length that drops it.
let y = [0, 1, 2, 3, 4, 5, 6, 7];
y[987654321] = 987654321;
console.log('mixed', y.length, y[987654321], y[7]);
y.length = 8;
console.log('truncated', y.length, y[987654321], 987654321 in y, y[3]);

// Growing past the materialization limit keeps only the length, and a
// write inside the hole range then lands in the dense prefix.
let z = [];
z[5000000] = 'a';
console.log('grown', z.length);
z[1] = 'b';
console.log('inside', z.length, z[0], z[1], z[5000000], z[4999999]);
z[5000000] = 'c';
console.log('replaced', z.length, z[5000000]);
z.length = 3;
console.log('shrunk', z.length, z[1], z[5000000], 5000000 in z);

// push, pop and at see the sparse length.
let w = [];
w[3000000] = 'w';
console.log('methods', w.at(0), w.at(3000000), w.at(-1), w.length);
w.push('pushed');
console.log('push', w.length, w[3000001]);
console.log('pop', w.pop(), w.length, w[3000000]);

// The build above is the program's: a dense array in the same program still
// shrinks through pop/shift/splice, and reads its length back.
let d = [1, 2, 3];
console.log('dense-pop', d.pop(), d.length, d.map((v) => v * 2).join(','));
let e = [4, 5, 6];
console.log('dense-shift', e.shift(), e.length, e.join(','));
let f = [7, 8, 9];
console.log('dense-splice', f.splice(1, 1).join(','), f.join(','), f.length);
let g = [1, 2, 3, 4, 5];
g.length = 2;
console.log('dense-truncate', g.length, g.join(','));
