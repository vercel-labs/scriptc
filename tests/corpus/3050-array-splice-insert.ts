const values = [0, 1, 2, 3];
console.log(JSON.stringify(values.splice(1, 0, 8, 9)), JSON.stringify(values));
console.log(JSON.stringify(values.splice(-2, 1, 6)), JSON.stringify(values));
console.log(JSON.stringify(values.splice(99, 4, 10)), JSON.stringify(values));
console.log(JSON.stringify(values.splice(-99, 99, 11, 12)), JSON.stringify(values));

const sparse = [1, , 3, 4];
const removed = sparse.splice(1, 1, 9, 10);
console.log(JSON.stringify(removed), removed.length, 0 in removed, JSON.stringify(sparse), 3 in sparse);
const more = [1, , 3, 4];
console.log(JSON.stringify(more.splice(1, 0, 8)), JSON.stringify(more), 2 in more);

const nullable: (number | undefined)[] = [1, 2];
nullable.splice(1, 0, undefined);
console.log(JSON.stringify(nullable), 1 in nullable, nullable[1] === undefined);

const first = { value: 1 };
const second = { value: 2 };
const records = [first, second];
const old = records.splice(1, 1, first, second);
console.log(old[0] === second, records[0] === first, records[1] === first, records[2] === second);

const events: string[] = [];
const ordered = [1, 2, 3];
function receiver(): number[] { events.push("receiver"); return ordered; }
function numberArg(label: string, value: number): number { events.push(label); return value; }
const taken = receiver().splice(numberArg("start", 1), numberArg("count", 1), numberArg("first", 7), numberArg("last", 8));
console.log(events.join("|"), JSON.stringify(taken), JSON.stringify(ordered));

const spread = [7, , 9] as number[];
const destination = [1, 2, 3];
console.log(JSON.stringify(destination.splice(1, 1, 6, ...spread, 10)), JSON.stringify(destination), 3 in destination);
const self = [1, 2, 3];
console.log(JSON.stringify(self.splice(1, 0, ...self)), JSON.stringify(self));
const original = [1, 2, 3];
console.log(JSON.stringify(original.toSpliced(1, 1, 6, ...spread, 10)), JSON.stringify(original));
