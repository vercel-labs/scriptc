// A property added to a class instance at runtime is present to `in`, and an
// absent name is not.
class Bag {
  owned = 1;
}
const bag = new Bag();
const view: any = bag;
console.log("bag:", "owned" in bag, "added" in bag, "nope" in bag);
view.added = 2;
console.log("bag:", "added" in bag, view.added);

// The same when the property arrives through a second instance's view only.
const other = new Bag();
const otherView: any = other;
otherView.added = 3;
console.log("other:", "added" in other, "owned" in other);
const fresh = new Bag();
console.log("fresh:", "added" in fresh);
