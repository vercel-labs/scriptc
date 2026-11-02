// Reading DisposableStack.prototype.use before the first stack exists answers
// the function stack.use does, and constructing a stack keeps that identity:
// the prototype object keeps the member it was built with.

const use = DisposableStack.prototype.use;
const adopt = DisposableStack.prototype.adopt;
const stack = new DisposableStack();
console.log("identity", use === stack.use, adopt === stack.adopt);
console.log(
  "prototype",
  DisposableStack.prototype.use === stack.use,
  DisposableStack.prototype.adopt === stack.adopt,
  use === DisposableStack.prototype.use,
);
const resource = {
  [Symbol.dispose]() {
    console.log("disposed");
  },
};
console.log("run", stack.use(resource) === resource, stack.disposed);
stack.dispose();
console.log("after", stack.disposed);
