// A union that reaches itself through a Set is not a value type the
// compiler supports. Held in a class field it is refused by name at the
// field, as it is anywhere else.
type Bag = string | Set<Bag>;

class Shelf {
  top: Bag = "empty";
}

const shelf = new Shelf();
console.log(typeof shelf.top);
