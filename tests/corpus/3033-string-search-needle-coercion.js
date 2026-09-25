// A JavaScript parameter has a checked-dynamic type in scriptc. A positioned
// indexOf must ToString its search value before converting the position,
// including when the value is not a string.
function find(needle, position) {
  return "abcabc".indexOf(needle, position);
}

console.log(find("bc", 1));
console.log(find("bc", "3"));
console.log(find(3, "0"));
console.log(find(true, 0));
