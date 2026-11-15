// A tuple element whose type admits undefined is one array element when the
// tuple becomes an untyped value: a present value (undefined included) is
// that value at its index, and only an omitted optional element is a hole.
// Later elements keep their indexes and the length is the tuple's.
function show(label: string, x: unknown): void {
  const arr = x as unknown[];
  let present = "";
  for (let i = 0; i < arr.length; i++) present += i in arr ? "1" : "0";
  console.log(label, arr.length, arr.map((item) => String(item)).join("|"), present, JSON.stringify(arr));
}
const required: [number | undefined, number] = [undefined, 2];
const filled: [number | undefined, number] = [1, 2];
const mixed: [a: number | undefined, b: string, c: number] = [undefined, "s", 3];
const optional: [number?, number?] = [undefined, 2];
const omitted: [number, number?, number?] = [1, , 3];
show("required", required);
show("filled", filled);
show("mixed", mixed);
show("optional", optional);
show("omitted", omitted);
const held: unknown = required;
console.log(JSON.stringify(held), (held as unknown[]).length, Object.keys(held as object).join(","));
console.log(JSON.stringify(mixed), mixed.length, JSON.stringify(omitted), omitted.length);

// A hole in a tuple literal that also spreads a tuple is still a hole.
const pair: [number, number] = [1, 2];
const spreadHole: [number?, number?, number?] = [, ...pair];
const spreadMiddle: [number, number?, number?, number?] = [0, , ...pair];
console.log(0 in spreadHole, 1 in spreadHole, spreadHole.length, spreadHole[0], spreadHole[1]);
console.log(1 in spreadMiddle, 2 in spreadMiddle, spreadMiddle.length);
show("spreadHole", spreadHole);
show("spreadMiddle", spreadMiddle);
