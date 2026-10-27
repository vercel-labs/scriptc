// Instances of a class that extends Date held in values typed only at run
// time: method calls, method values, conversions and instanceof through
// those values, and JSON and console output of the containers.
class Day extends Date {
  #label;
  constructor(value, label) {
    super(value);
    this.#label = label;
  }
  get label() {
    return this.#label;
  }
  toISOString() {
    return super.toISOString().slice(0, 10);
  }
}
class Plain extends Date {}

const box = JSON.parse('{"items":[],"byName":{}}');
box.items.push(new Day(Date.UTC(2020, 1, 29), "leap"), new Plain(0), new Date(1000), "text");
box.byName.first = box.items[0];

function inspect(value) {
  if (!(value instanceof Date)) return "not a date: " + value;
  return [value.toISOString(), value.getTime(), value.getUTCDate(), value instanceof Day, value.toJSON()].join(" | ");
}
for (const item of box.items) console.log(inspect(item));
console.log(JSON.stringify(box));
console.log(box.byName.first.label, box.byName.first.getUTCFullYear(), String(box.items[1]).slice(0, 15));
console.log(+box.items[0], box.items[0] - box.items[1], box.items[0] > box.items[2], `${box.items[1]}`.slice(0, 3));

const getTime = box.items[0].getTime;
console.log(getTime.call(box.items[1]), getTime.call(box.items[0]), typeof getTime);
const toISO = box.items[0].toISOString;
console.log(toISO.call(box.items[0]));
console.log(box.items[1].setTime(5000), box.items[1].getTime(), box.items[1].toISOString());
try {
  getTime.call({});
} catch (error) {
  console.log(error instanceof TypeError);
}
console.log(box.items);
console.log(new Date(box.items[0]).toISOString(), new Date(box.items[1]).getTime());
