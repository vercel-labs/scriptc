// A record built from dynamic data enumerates in the order the object
// creates its keys: deleting a declared optional key removes it from that
// order, and writing it again puts it last, as Node's own-property table
// does. Differentially vs Node.
interface Row {
  p: string;
  q?: string;
  r: string;
}
const row = JSON.parse('{"p":"1","q":"2","r":"3"}') as Row;
console.log(Object.keys(row).join(","), JSON.stringify(row));
delete row.q;
console.log(Object.keys(row).join(","), JSON.stringify(row));
row.q = "9";
console.log(Object.keys(row).join(","), JSON.stringify(row));
const late = JSON.parse('{"p":"4","r":"6"}') as Row;
late.q = "7";
console.log(Object.keys(late).join(","), JSON.stringify(late));
const keep: Row = { p: "8", q: "9", r: "10" };
keep.q = "11";
console.log(Object.keys(keep).join(","), JSON.stringify(keep));
