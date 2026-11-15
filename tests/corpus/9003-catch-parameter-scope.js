// A catch parameter's block may not redeclare it lexically, but a `var` in
// the block is Annex B's legacy and a nested block has its own declarations.
function parse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    var error2 = "recovered: " + error.message;
    {
      function error() {
        return 1;
      }
      console.log(typeof error === "function");
    }
    return error2;
  }
}
console.log(parse("{"));
console.log(parse("1"));
