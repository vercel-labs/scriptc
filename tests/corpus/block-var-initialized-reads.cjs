// A `var` declared with a value inside a block and read only after it, in
// that block, holds the value's type: it never reads undefined there.
function view(n) {
  if (n > 0) {
    var bytes = new Uint8Array(n);
    1 < n && (bytes = bytes.subarray(1));
    return bytes.length;
  }
  return -1;
}
function rows(list) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var row = { id: list[i], label: "row " + list[i] };
    out.push(row.label + ":" + row.id);
  }
  return out.join(",");
}
console.log(view(1), view(3), view(0), rows([1, 2, 3]));
