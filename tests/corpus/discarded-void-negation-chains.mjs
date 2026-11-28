// A discarded chain of `!` and parentheses over a call the checker types
// `void` (a callback annotated `() => void`) still evaluates the call once
// per expression for its effects and exceptions; the final boolean is never
// read. Node calls the callback twice.
/** @param {() => void} callback */
function invoke(callback) {
  !!callback();
  !!!(callback());
  !!((callback()));
}
invoke(() => console.log("registered"));
