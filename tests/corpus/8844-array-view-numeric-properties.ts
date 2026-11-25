// A live array's noncanonical numeric properties are stored on the native
// array, and a checked view copies them out of that storage on every
// refresh: a delete through the view stays deleted, and the numeric
// properties that remain keep their values.
const xs: number[] = [1, 2];
const view: any = xs;
view[-1] = 9;
view["1.5"] = 4;
view["2.5"] = 6;
view.tag = "t";
console.log("set", view[-1], view["1.5"], view["2.5"], view.tag, JSON.stringify(Object.keys(view)));
console.log("native", xs[-1], xs[1.5] as number | undefined);

delete view[-1];
view["3.5"] = 8;
console.log(
  "deleted",
  view[-1],
  "-1" in view,
  Object.prototype.hasOwnProperty.call(view, "-1"),
  view["1.5"],
  view["2.5"],
  view["3.5"],
  view.tag,
);

// Another view of the same array answers the same storage after its own
// refresh.
const again: any = xs as unknown as unknown[];
console.log("again", again[-1], again["1.5"], again["2.5"], again["3.5"], again.tag);

// An Array subclass follows the same rule for the numeric properties.
class Row extends Array<number> {
  label = "row";
}
const row = new Row() as any;
row.push(1);
row[-1] = 7;
row.tag = "r";
console.log("row", row[-1], row.tag, row.label);
delete row[-1];
row["4.5"] = 8;
console.log(
  "row deleted",
  row[-1],
  "-1" in row,
  Object.prototype.hasOwnProperty.call(row, "-1"),
  row["4.5"],
  row.tag,
  row.label,
);

// A numeric property deleted through one view stays deleted for another view
// of the same array: the second view refreshes from the native storage, which
// no longer holds the key.
const shared: number[] = [1, 2];
const first: any = shared;
first["6.5"] = 4;
const second: any = shared as unknown as unknown[];
console.log("shared cached", first["6.5"]);
delete second["6.5"];
console.log("shared deleted", first["6.5"], "6.5" in first, "6.5" in second);
