// CatchParameter's BoundNames may not occur in the LexicallyDeclaredNames of
// its block. The checker reports the let/const spellings; a plain function
// declaration is the form it misses, and Node refuses it in both modes.
function parse() {
  try {
    return JSON.parse("null");
  } catch (error) {
    function error() {}
    return error;
  }
}
parse();
