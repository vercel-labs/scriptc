// Captured parameters that are never rebound keep the caller's reference
// until a closure needs its own, including closures that outlive the call.
class Account {
  owner: string;
  balance: number;
  constructor(owner: string, balance: number) {
    this.owner = owner;
    this.balance = balance;
  }
}

function over(account: Account, limit: number): boolean {
  return account.balance > limit;
}

function anyOver(account: Account, limits: number[]): boolean {
  if (limits.length === 0) return false;
  return limits.some((limit) => over(account, limit));
}

const reports: (() => string)[] = [];
function schedule(account: Account, label: string): number {
  if (label === "") return reports.length;
  reports.push(() => `${label}: ${account.owner} ${account.balance}`);
  return reports.length;
}

function nested(account: Account, rows: number[][]): number {
  if (rows.length === 0) return -1;
  return rows.filter((row) => row.some((limit) => over(account, limit))).length;
}

function rebound(account: Account, swap: Account): string {
  const before = () => account.owner;
  const first = before();
  account = swap;
  return `${first} -> ${before()}`;
}

function reboundInside(account: Account, swap: Account): string {
  const replace = () => {
    account = swap;
  };
  const owner = account.owner;
  replace();
  return `${owner} -> ${account.owner}`;
}

class Ledger {
  entries: Account[] = [];
  match(account: Account, owners: string[]): string[] {
    if (owners.length === 0) return [];
    return owners.filter((owner) => owner === account.owner);
  }
}

function refuse(message: string): never {
  throw new Error(message);
}

function richOrRefuse(account: Account, limits: number[]): number {
  if (limits.length > 0) return limits.filter((limit) => over(account, limit)).length;
  return refuse(`no limits for ${account.owner}`);
}

function makeCounter(account: Account): () => number {
  let calls = 0;
  return () => {
    calls++;
    return account.balance * calls;
  };
}

const alice = new Account("alice", 40);
const bob = new Account("bob", 5);
console.log(anyOver(alice, []), anyOver(alice, [50, 30]), anyOver(bob, [10]));
console.log(schedule(alice, ""), schedule(alice, "first"), schedule(bob, "second"));
alice.balance = 45;
for (const report of reports) console.log(report());
console.log(nested(alice, []), nested(alice, [[1], [100], [44, 46]]));
console.log(rebound(alice, bob), reboundInside(alice, bob), alice.owner);
const ledger = new Ledger();
console.log(ledger.match(bob, []).length, ledger.match(bob, ["bob", "alice", "bob"]).join(","));
console.log(richOrRefuse(alice, [1, 50, 2]));
try {
  richOrRefuse(bob, []);
} catch (error) {
  console.log(String(error));
}
const counter = makeCounter(new Account("temp", 3));
console.log(counter(), counter(), counter());
let total = 0;
for (let i = 0; i < 1000; i++) if (anyOver(i % 2 === 0 ? alice : bob, i % 3 === 0 ? [] : [10])) total++;
console.log(total);
