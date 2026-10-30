// for-in over class instances seen as `unknown`: own fields in creation
// order, then properties added through the dynamic view; prototype
// methods and accessors are not enumerable; keys deleted before their
// turn are skipped and keys added during the walk are not visited.
class Account {
  owner: string;
  balance: number;
  constructor(owner: string, balance: number) {
    this.owner = owner;
    this.balance = balance;
  }
  get doubled(): number {
    return this.balance * 2;
  }
  deposit(amount: number): void {
    this.balance += amount;
  }
}
class Savings extends Account {
  rate = 0.5;
}

function walk(label: string, value: unknown): void {
  const keys: string[] = [];
  for (const key in value as object) keys.push(key);
  console.log(label, keys.join(",") || "(none)");
}

class Empty {}
walk("empty", new Empty());
const account = new Account("ann", 10);
account.deposit(5);
walk("account", account);
const base: Account = new Savings("bo", 1);
walk("savings", base);

// Properties added through the dynamic view follow the fields.
const seen: unknown = account;
const view = seen as Record<string, unknown>;
view.note = "n";
view.tag = 1;
walk("extended", view);

// Deleted before their turn: skipped. Added during the walk: not visited.
const visited: string[] = [];
for (const key in view) {
  visited.push(key);
  if (key === "owner") {
    delete view.tag;
    view.later = true;
  }
}
console.log("mutating", visited.join(","), Object.keys(view).join(","));

// for-in reaches enumerable properties of a prototype set through the view.
const inherited = { inherited: 1 };
Object.setPrototypeOf(view, inherited);
walk("inherited", view);
function alias(value: Account): Record<string, unknown> {
  const checked: unknown = value;
  return checked as Record<string, unknown>;
}
walk("inherited alias", alias(account));
console.log("alias prototype", Object.getPrototypeOf(alias(account)) === inherited, "inherited" in alias(account));
Object.setPrototypeOf(alias(account), null);
walk("null alias", view);
console.log("null prototype", Object.getPrototypeOf(view) === null, "inherited" in view);
console.log("values", account.balance, JSON.stringify(view));
