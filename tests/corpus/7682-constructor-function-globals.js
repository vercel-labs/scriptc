// Module bindings that hold `new F()` of an ordinary constructor function
// (const, let and var), read and reassigned by functions declared elsewhere
// in the module, such as the head and tail of a linked list.
'use strict';
function Segment(prev) {
  this.prev = prev;
  this.next = null;
  this.data = new Array(4);
  this.pos = 0;
}
const head = new Segment();
let current = head;
var spare = new Segment(head);

function append(value) {
  if (current.pos === current.data.length) {
    current = current.next || (current.next = new Segment(current));
  }
  current.data[current.pos++] = value;
}

function collect() {
  const out = [];
  for (let node = head; node; node = node.next) out.push(node.data.slice(0, node.pos).join(''));
  return out.join('|');
}

function reset() {
  current = head;
  for (let node = head; node; node = node.next) node.pos = 0;
}

for (const ch of 'abcdefghij') append(ch);
console.log(collect(), current === head, current.prev === head.next ? 'two' : 'more');
reset();
append('z');
console.log(collect(), current === head, head.next !== null);
console.log(spare.prev === head, spare instanceof Segment, typeof spare.data);
spare = new Segment(spare);
console.log(spare.prev.prev === head);

function Counter(start) {
  this.value = start;
}
Counter.prototype.bump = function () {
  return ++this.value;
};
let counter = new Counter(10);
function bumpTwice() {
  counter.bump();
  return counter.bump();
}
console.log(bumpTwice(), counter.value);
counter = new Counter(0);
console.log(bumpTwice());
