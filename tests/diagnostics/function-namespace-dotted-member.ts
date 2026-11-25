// `namespace f.inner` merged with `function f` gives the function ONE own
// property, `inner`, whose value is a second object holding the block's
// exports. The function's own-property table has no nested object to put
// there, so the dotted declaration is refused by name, exactly as the
// `export namespace inner` spelling is, rather than storing the inner
// exports on the function itself.
function f(): number {
  return 1;
}
namespace f.inner {
  export const x = 2;
}
console.log(Object.keys(f), f.inner.x);
