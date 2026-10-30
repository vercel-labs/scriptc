// Function-valued properties of class instances in a JavaScript program:
// methods assigned in the constructor, replaced later, and called through
// the instance read `this` for the instance they were called on. Dynamic
// views of the bound instance, record and array see their members.
'use strict';
class Greeter {
  hello() {
    return 'hi';
  }
  constructor(name) {
    this.name = name;
    this.greet = function (other) {
      return `${this.name} greets ${other}`;
    };
    this.shout = (other) => `${other.toUpperCase()}!`;
  }
}
const g = new Greeter('ann');
const h = new Greeter('ben');
console.log(g.greet('you'), h.greet('me'), g.shout('hey'));
h.greet = g.greet;
console.log(h.greet('again'));
let calls = 0;
g.greet = function (other) {
  calls++;
  return `${this === g} ${this === h} ${other}`;
};
console.log(g.greet('x'), calls);
g.probe = function () {
  const keys = [];
  for (const k in this) keys.push(k);
  return `${'hello' in this} ${'constructor' in this} ${'missing' in this} ${Object.keys(this).join(',')} ${keys.join(',')}`;
};
console.log(g.probe());
const rec = {
  n: 1,
  tag: 'r',
  show() {
    const keys = [];
    for (const k in this) keys.push(k);
    return `${'n' in this} ${'missing' in this} ${Object.keys(this).join(',')} ${keys.join(',')}`;
  },
};
console.log(rec.show());
const fns = [
  function () {
    return `${Array.isArray(this)} ${this.length} ${0 in this} ${1 in this} ${Object.keys(this).join(',')}`;
  },
];
console.log(fns[0]());

// Reflecting a base prototype makes its live slots authoritative, even if
// presence was lowered before the later body that exposes the prototype.
class PresenceBase { inherited() { return 1; } }
class PresenceChild extends PresenceBase { own() { return 2; } }
const presenceChild = new PresenceChild();
let presenceReads = 0;
function presenceReceiver() { presenceReads++; return presenceChild; }
function reportPresence(value, key) {
  console.log('inherited' in value, key in value, !('inherited' in value), 'own' in value);
}
reportPresence(presenceReceiver(), 'inherited');
function exposeBase() { return Object.getPrototypeOf(new PresenceBase()); }
const exposedBase = exposeBase();
const inheritedKey = ['inherited'].join('');
delete exposedBase[inheritedKey];
reportPresence(presenceReceiver(), inheritedKey);
exposedBase[inheritedKey] = 3;
reportPresence(presenceReceiver(), inheritedKey);
Object.setPrototypeOf(presenceChild, null);
reportPresence(presenceReceiver(), inheritedKey);
console.log('presence reads', presenceReads);
