// Releasing a long chain of instances of a class that extends Array, each
// holding the next one, tears them down without growing the native stack.
class Link extends Array<number> {
  next: Link | null = null;
}

let head: Link | null = new Link();
let tail = head;
for (let i = 0; i < 300000; i++) {
  const link = new Link();
  link.push(i);
  tail.next = link;
  tail = link;
}
console.log(tail.length, tail[0]);
head = null;
console.log("released", head);
