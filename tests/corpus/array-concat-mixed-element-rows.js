// Rows that mix strings and numbers, assembled with concat in untyped code
// (the shape of the WPT Range mutation tests' data tables): concat keeps
// every element as it is, whichever element type the receiver's array has,
// and a `var` that is still undefined appends as one element.
var node = "n";
var ranges = [];
for (var i = 0; i < 2; i++) {
  var row = [node, i, node, 0];
  ranges.push([node, '"data"', '"="', '""'].concat(row));
}
console.log(ranges.length, JSON.stringify(ranges));

function mixed() {
  var row = [node, 1, node, 2];
  var all = [node, "x"].concat(row);
  console.log(all.length, typeof all[3], all[3] + 1, all.join("|"));
  var more = all.concat([3]).concat(row, [4]);
  console.log(more.length, JSON.stringify(more));
  console.log(
    ["a"]
      .concat(row)
      .map(function (v) {
        return typeof v;
      })
      .join(","),
  );
  var later;
  var withHole = ["h"].concat(later === undefined ? [later] : later);
  console.log(withHole.length, String(withHole[1]));
}
mixed();
