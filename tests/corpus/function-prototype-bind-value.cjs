// Function.prototype.bind read as a value binds the receiver it is called on.
const bind = Function.prototype.bind;

function describe(prefix, value) {
  return `${prefix}: ${this.name} ${value}`;
}

const bound = bind.call(describe, { name: "first" }, "call");
console.log(bound(1));

const applied = bind.apply(describe, [{ name: "second" }, "apply"]);
console.log(applied(2));
console.log(applied.name, typeof applied);

const log = bind.apply(console.log, [console, "[prefixed]"]);
log("message", 3);

try {
  bind.call({});
} catch (error) {
  console.log(error instanceof TypeError);
}
