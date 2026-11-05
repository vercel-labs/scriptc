// A species result of another element type is still an instance of the
// class, so `instanceof` narrows it back. Its elements are not the class's,
// so the class's fields and methods on it are refused where they are read.
class Holder {
  tag = "h";
}

class Group extends Array<Holder | null> {
  owner: Holder | null = null;

  firstTag(): string {
    const first = this[0];
    return first === null || first === undefined ? "none" : first.tag;
  }
}

const groups = new Group();
groups.push(new Holder(), null);
const numbers = groups.map((_, i) => i + 1);
if (numbers instanceof Group) {
  numbers.owner = new Holder();
  console.log(numbers.owner.tag);
  console.log(numbers.firstTag());
}
