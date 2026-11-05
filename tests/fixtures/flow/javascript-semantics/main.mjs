import { Component, bound, label, slots } from "./classes.js";

const c = new Component({ a: 1 }, null);
c.setState({ b: 2 }, (n) => console.log("callback", n));
c.setState({ c: 3 });
console.log(c.describe(), JSON.stringify(c.props), c.updates.length);
console.log(label(3), label.displayName, slots(4), bound("> ")("x"));
