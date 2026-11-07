// TypeScript types a read by the last assignment in the read's own function
// and keeps that across a call, so each of these functions is inferred to
// return `undefined` although `search()` assigned `found` since. Returning
// nothing would drop the value, and the callers' types come from the same
// inference: the return needs a declared type.
let found: string | undefined = undefined;
function search(): void {
  found = "hit";
}
function result() {
  found = undefined;
  search();
  return found;
}
function either(first: boolean) {
  found = undefined;
  search();
  return first ? found : undefined;
}
class Finder {
  hit: string | undefined = undefined;
  look(): void {
    this.hit = "hit";
  }
  result() {
    this.hit = undefined;
    this.look();
    return this.hit;
  }
}
result();
either(true);
new Finder().result();
search();
(() => found)();
