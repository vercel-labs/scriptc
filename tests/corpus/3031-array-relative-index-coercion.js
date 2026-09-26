const values = [10, 20, 30];

console.log(values.at() ?? -1, values.at(undefined) ?? -1, values.at(null) ?? -1);
console.log(values.at(false) ?? -1, values.at(true) ?? -1, values.at(" 2 ") ?? -1);
console.log(values.at("-1.8") ?? -1, values.at("no") ?? -1, values.at("Infinity") ?? -1);

let calls = 0;
function index() {
  calls++;
  return "1";
}
console.log(values.at(index()) ?? -1, calls);

const sparse = [1, , 3];
console.log(sparse.at(1) === undefined, sparse.at(-1) ?? -1);

console.log(values.with("1", 99).join(","), values.with("-1", 7).join(","));
console.log(values.with(false, 4).join(","), values.with(true, 5).join(","));
console.log(values.with(null, 6).join(","), values.with(undefined, 8).join(","));
console.log(values.with("bad", 9).join(","), values.join(","));
function mixedPosition(useString) {
  return useString ? "1" : false;
}
console.log(values.at(mixedPosition(true)) ?? -1, values.at(mixedPosition(false)) ?? -1);
console.log(values.with(mixedPosition(true), 11).join(","), values.with(mixedPosition(false), 12).join(","));
console.log(values.with("1", values[99]).at(1) === undefined);

const events = [];
function receiver() {
  events.push("receiver");
  return values;
}
function position() {
  events.push("index");
  return "2";
}
function replacement() {
  events.push("value");
  return 42;
}
console.log(receiver().with(position(), replacement()).join(","), events.join(","));
