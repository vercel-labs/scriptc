// Replacing an instance's prototype can release the last reference to other
// instances whose prototypes were replaced too: each prototype below owns
// the instance made before it. Replacing the head's prototype frees the
// whole chain within the call, and the head keeps the prototype it was
// given, as in Node.
class Item {
  constructor(id) {
    this.id = id;
  }
  name() {
    return "item" + this.id;
  }
}

function chain(length) {
  let head = null;
  for (let i = 0; i < length; i++) {
    const prototype = Object.create(Item.prototype);
    prototype.next = head;
    const item = new Item(i);
    Object.setPrototypeOf(item, prototype);
    head = item;
  }
  return head;
}

function depth(item) {
  let count = 0;
  for (let at = item; at; at = Object.getPrototypeOf(at).next) count++;
  return count;
}

for (const length of [3, 17, 64, 200, 333]) {
  const head = chain(length);
  const before = depth(head);
  const replacement = Object.create(Item.prototype);
  replacement.tag = "replacement " + length;
  Object.setPrototypeOf(head, replacement);
  console.log(
    length,
    before,
    Object.getPrototypeOf(head) === replacement,
    Object.getPrototypeOf(head).tag,
    head.name(),
    head instanceof Item,
    depth(head),
  );
  // Back to the class's prototype, which releases the replacement.
  Object.setPrototypeOf(head, Item.prototype);
  console.log(Object.getPrototypeOf(head) === Item.prototype, head.name());
}

// Fresh instances afterwards keep their class's prototype.
const fresh = [new Item(1), new Item(2), new Item(3)];
console.log(fresh.map((item) => `${Object.getPrototypeOf(item) === Item.prototype}:${item.name()}`).join(" "));
