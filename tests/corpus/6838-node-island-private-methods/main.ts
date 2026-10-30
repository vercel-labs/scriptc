// @requires-libnode
// A native class instance passed into a Node island shows the island only
// its public members: its #private methods, and the names the compiler
// gives accessors and symbol-keyed methods, read as undefined, as in Node.
import { probe, shadow } from "private-pkg";

class Account {
  #balance = 10;
  owner: string;
  constructor(owner: string) {
    this.owner = owner;
  }
  #secret(): string {
    return `secret of ${this.owner}: ${this.#balance}`;
  }
  get label(): string {
    return `account ${this.owner}`;
  }
  describe(): string {
    return `${this.owner} (${this.#secret().length})`;
  }
  *[Symbol.iterator](): Generator<string> {
    yield this.owner;
  }
}

const a = new Account("ada");
console.log(probe(a));
console.log(a.describe(), [...a].join(","));
console.log(shadow(new Account("bob")));
