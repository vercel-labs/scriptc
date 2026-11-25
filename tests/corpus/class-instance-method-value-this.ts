// A class instance's method read as a value runs against whatever receiver
// the call supplies (`call`, `apply`, `Reflect.apply`), and a wrapper stored
// back on one instance shadows the class method for that instance alone.
// mock.method on an instance replaces the method for that instance, records
// the instance as each call's `this`, and restore gives the class method
// back.
import { mock } from "node:test";
import { mock as renamedMock } from "node:test";

class Account {
  owner: string;
  balance: number;
  constructor(owner: string, balance: number) {
    this.owner = owner;
    this.balance = balance;
  }
  deposit(amount: number): string {
    this.balance += amount;
    return `${this.owner}:${this.balance}`;
  }
}

const alice = new Account("alice", 10);
const bob = new Account("bob", 100);
const deposit = alice.deposit;
console.log(deposit.call(bob, 5), Reflect.apply(deposit, alice, [1]));
alice.deposit = function (this: Account, amount: number): string {
  return `wrapped(${deposit.call(this, amount * 2)})`;
};
console.log(alice.deposit(3), bob.deposit(1));

const m = mock.method(bob, "deposit", (amount: number): string => `mocked:${amount}`);
console.log(bob.deposit(7), m.mock.callCount(), m.mock.calls[0]!.this === bob);
console.log(alice.deposit(1));
m.mock.restore();
console.log(bob.deposit(7), bob.balance);
const p = mock.method(bob, "deposit");
console.log(p.mock.calls.length, bob.deposit(2));
p.mock.restore();
console.log(bob.deposit(2));

// An import of `mock` under another local name is the same tracker, so a
// class instance's method it replaces is still the one its calls run.
const aliased = renamedMock.method(alice, "deposit");
console.log(alice.deposit(1));
console.log(aliased.mock.calls[0]!.this === alice);
aliased.mock.restore();
console.log(alice.deposit(1));
