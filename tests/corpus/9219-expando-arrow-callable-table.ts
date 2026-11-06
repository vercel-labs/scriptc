// Expando members on a callable const: the arrow function carries its own
// properties, reads them from inside its body, and enumerates them through
// Object.keys. A second name for the same function observes every write.
const greet = (name: string): string => `${greet.prefix}${name}`;
greet.prefix = "hello ";
console.log(greet("a"));
greet.prefix = "bye ";
const g2 = greet;
console.log(g2("b"), Object.keys(greet));
