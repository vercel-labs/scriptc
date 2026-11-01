// A set accessor with no parameter type annotation is legal JavaScript: the
// parameter is whatever the caller passes, and the object stores it as-is.
// TypeScript types the parameter from a twin getter's return, and reports
// TS7032 (the property "implicitly has type 'any'") when there is none; both
// are opinions about TypeScript input, and a JavaScript source keeps the
// runtime value.
const literal = {
  stored: 0,
  set value(next) {
    this.stored = next;
  },
  get value() {
    return this.stored;
  },
};
literal.value = 42;
console.log(literal.value, literal.stored);
literal.value = "text";
console.log(literal.value, typeof literal.value);

class Store {
  constructor() {
    this.stored = null;
  }
  set value(next) {
    this.stored = next;
  }
  get value() {
    return this.stored;
  }
}
const store = new Store();
store.value = { kind: "object" };
console.log(store.value.kind, store.value === store.stored);
store.value = 7;
console.log(store.value + 1, store.value * 2, `${store.value}`);

// The same value reaches arithmetic, concatenation and a nested structure;
// the setter never coerces, so each read observes the value that was set.
// This setter has no twin getter — the TS7032 construct itself: the checker
// has no getter to type the parameter from and calls it `any`, which is just
// what a JavaScript caller passes.
const sink = {
  items: [],
  set push(next) {
    this.items[this.items.length] = next;
  },
};
sink.push = 1;
sink.push = "two";
sink.push = null;
sink.push = undefined;
console.log(sink.items.length, sink.items.join("|"), sink.items[2] === null, sink.items[3] === undefined);

class Temperature {
  constructor(celsius) {
    this.celsius = celsius;
  }
  set fahrenheit(next) {
    this.celsius = (next - 32) / 1.8;
  }
  get fahrenheit() {
    return this.celsius * 1.8 + 32;
  }
}
const temperature = new Temperature(0);
temperature.fahrenheit = 212;
console.log(Math.round(temperature.celsius), Math.round(temperature.fahrenheit));
temperature.fahrenheit = undefined;
console.log(Number.isNaN(temperature.celsius));
