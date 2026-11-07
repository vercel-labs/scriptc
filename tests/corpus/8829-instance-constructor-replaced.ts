// A program can replace `constructor` itself. An instance given an own
// property of that name answers it from then on, as in Node; the other
// instances of the class, and its subclasses, keep answering their class.

class Tagged {
  x = 1;
  tag(): string {
    return this.constructor.name;
  }
  isTagged(): boolean {
    return this.constructor === Tagged;
  }
}
class Derived extends Tagged {}

const replaced = new Tagged();
Object.defineProperty(replaced, "constructor", { value: Object });
const keyed: Tagged = new Derived();
const key: string = ["con", "structor"].join("");
(keyed as any)[key] = Tagged;
console.log(
  replaced.tag(),
  replaced.isTagged(),
  replaced.constructor === Object,
  keyed.tag(),
  keyed.isTagged(),
  new Tagged().tag(),
  new Tagged().isTagged(),
  new Derived().tag(),
  new Derived().isTagged(),
);

// The same for a class with a static read through its constructor: an
// instance whose constructor the program left alone still reads its own
// class's static.
class Model {
  static table = "models";
  where(): string {
    return (this.constructor as typeof Model).table;
  }
}
class User extends Model {
  static table = "users";
}
const user = new User();
(user as any).extra = 1;
console.log(user.where(), new Model().where(), (user as any).extra);
