// Destructuring assignment into members of untyped objects and arrays: the
// swap `[a[i], a[j]] = [a[j], a[i]]`, property targets, object patterns,
// defaults, the order the parts are evaluated in, and the errors a member
// write makes.
class Grid {
  constructor() {
    this.cells = ['a', 'b', 'c', 'd']
    this.marks = [1, 2, 3, 4]
  }
  flip() {
    for (let i = 0, j = this.cells.length - 1; i < j; i++, j--) {
      [this.cells[i], this.cells[j]] = [this.cells[j], this.cells[i]];
      [this.marks[i], this.marks[j]] = [this.marks[j], this.marks[i]]
    }
  }
}
const grid = new Grid()
grid.flip()
console.log(grid.cells.join(''), grid.marks.join(''))

const numbers = [1, 2, 3]
let a = 0, b = 1;
[numbers[a], numbers[b]] = [numbers[b], numbers[a]];
[a, b] = [b, a]
const pair = { left: 'l', right: 'r' };
[pair.left, pair.right] = [pair.right, pair.left]
console.log(numbers.join(','), a, b, pair.left, pair.right)

const log = []
const box = { a: 1, b: 2, list: [] }
const pick = (name) => {
  log.push(name)
  return box
}
let n = 0;
[pick('first').a, pick('second').b] = [(log.push('x'), 10), (log.push('y'), 20)];
[box.list[n++], box.list[n++], box.list[5] = 'default'] = ['p', 'q'];
({ a: box.c, b: box['d' + n] } = { a: 'A', b: 'B' })
console.log(log.join(','), JSON.stringify(box), n, box.list.length)

const holder = { inner: null, frozen: Object.freeze({ x: 0 }) }
try {
  [holder.inner.x] = [1]
} catch (e) {
  console.log(e instanceof TypeError, e.message)
}
try {
  [holder.frozen.x] = [1]
} catch (e) {
  console.log(e instanceof TypeError, e.message)
}
console.log(holder.frozen.x)

// The source array literal is evaluated before the first write, so a
// target may name what the literal read from.
const words = ['b', 'a', 'c']
const ends = { low: 'z', high: 'y' };
[ends.low, ends.high] = [words[0], words[1]];
[words[0], words[1], words[2]] = [ends.high, ends.low, words[0]]
console.log(JSON.stringify(ends), words.join(''))
let reads = 0
const counter = { get next() { return ++reads } }
const tally = { first: 0, second: 0 };
[tally.first, tally.second] = [counter.next, counter.next]
console.log(JSON.stringify(tally), reads)

// A source that is not a literal is read one element at a time, after the
// earlier targets were assigned: a target that is the source, or one of its
// elements, changes what the later ones receive.
const o = { list: ['x', 'y', 'z'], x: '', y: '' };
[o.x, o.y] = o.list
console.log(o.x, o.y);
[o.list[2], o.list[1], o.list[0]] = o.list
console.log(o.list.join(''))
const p = { v: [10, 20] };
[p.v[1], p.w] = p.v
console.log(JSON.stringify(p))
let seen = '';
[o.list[1], seen] = o.list
console.log(o.list.join(''), seen)
const sparse = { v: ['a', , 'c', 'd'], out: [] };
[sparse.out[0], , sparse.v[3], sparse.out[1] = 'none', sparse.out[2] = 'past'] = sparse.v
console.log(JSON.stringify(sparse))
const plain = [1, 2];
[plain[1], plain[0]] = plain
console.log(plain.join(','))
