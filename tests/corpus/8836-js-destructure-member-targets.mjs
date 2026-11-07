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

const words = ['b', 'a']
const ends = { low: 'z', high: 'y' };
[ends.low, ends.high] = words;
[words[0], words[1]] = [ends.high, ends.low]
console.log(JSON.stringify(ends), words.join(''))
