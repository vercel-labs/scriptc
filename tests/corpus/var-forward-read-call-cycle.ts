// Two `var`s with no unconditional store, read through a mutually recursive
// call chain that code above their declarations can enter: each read sees
// `undefined`, and one binding's reader being proven safe settles nothing for
// the other binding's reader.
function outer(): void {
  let depth = 0;
  function f(): number {
    return a === undefined ? g() : g() + a;
  }
  function g(): number {
    return h() + b;
  }
  function h(): number {
    return depth > 3 ? 0 : (depth++, f());
  }
  console.log("early", f());
  var a: number;
  var b: number;
  console.log("late", f());
}
outer();
