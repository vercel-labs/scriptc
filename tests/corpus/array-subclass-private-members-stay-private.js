// An instance of a class that extends Array, reached through untyped
// values, answers string keys with its public members only: its private
// (`#`) fields, getters and methods are no properties of it, as in Node,
// whether the key is a literal, a variable or an `in` test. A plain class
// beside it answers the same way.
class Vault extends Array {
  #secret = "s";
  get #hidden() {
    return "hidden " + this.#secret;
  }
  #reveal() {
    return "revealed " + this.#secret;
  }
  get open() {
    return "open";
  }
  peek() {
    return this.#hidden + " / " + this.#reveal();
  }
}

class Box {
  #secret = "s";
  get #hidden() {
    return "hidden " + this.#secret;
  }
  #reveal() {
    return "revealed " + this.#secret;
  }
  get open() {
    return "open";
  }
}

function probe(label, value) {
  for (const key of [
    "#hidden",
    "#reveal",
    "#secret",
    "open",
    "peek",
    // The accessor members' internal names: an untyped string key names a
    // property, not the getter or setter the class compiled.
    "get:hidden",
    "set:hidden",
    "get:#hidden",
    "set:#hidden",
    "get:secret",
    "get:reveal",
  ]) {
    let read;
    try {
      read = typeof value[key] === "function" ? "function" : String(value[key]);
    } catch (e) {
      read = String(e);
    }
    console.log(label, key, key in value, read);
  }
  try {
    console.log(label, value["#reveal"]());
  } catch (e) {
    console.log(label, "call", String(e));
  }
  try {
    console.log(label, value["#hidden"]);
  } catch (e) {
    console.log(label, "read", String(e));
  }
}

const vaults = [new Vault()];
probe("vault", vaults[0]);
console.log(vaults[0].peek());
probe("box", [new Box()][0]);
