// The standard error constructors called as functions construct errors too,
// and Function.prototype.call ignores the receiver it is given.
const plain = Error("plain");
const typed = TypeError("typed");
const range = RangeError();
const withCause = Error("wrapped", { cause: plain });
console.log(plain instanceof Error, plain.message, String(plain));
console.log(typed instanceof TypeError, typed instanceof Error, typed.name, typed.message);
console.log(range instanceof RangeError, JSON.stringify(range.message), String(range));
console.log(withCause.cause === plain, withCause.message);
console.log(SyntaxError("s").name, ReferenceError("r").name, EvalError("e").name, URIError("u").name);

const receiver = { marker: true };
const called = Error.call(receiver, "via call");
console.log(called instanceof Error, called.message, Object.keys(receiver), called === receiver);
const typedCall = TypeError.call(null, "typed via call");
console.log(typedCall instanceof TypeError, typedCall.message);
const noArguments = Error.call();
console.log(noArguments instanceof Error, JSON.stringify(noArguments.message));

let evaluated = 0;
function effect(value) {
  evaluated++;
  return value;
}
const ordered = Error.call(effect({}), effect("ordered"));
console.log(evaluated, ordered.message);

function Wrapper(message) {
  const base = Error.call(this, message);
  this.message = base.message;
  this.kind = "wrapper";
}
const wrapped = new Wrapper("kept");
console.log(wrapped.message, wrapped.kind, wrapped instanceof Wrapper, wrapped instanceof Error);
try {
  throw Error("thrown without new");
} catch (error) {
  console.log(error instanceof Error, error.message);
}
