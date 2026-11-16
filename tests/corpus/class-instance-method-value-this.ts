// A class instance's method read as a value runs against whatever receiver
// the call supplies (`call`, `apply`, `Reflect.apply`), and a wrapper stored
// back on one instance shadows the class method for that instance alone.
// mock.method on an instance replaces the method for that instance, records
// the instance as each call's `this`, and restore gives the class method
// back.
import { mock } from "node:test";

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
