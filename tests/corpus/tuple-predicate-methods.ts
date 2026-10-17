export {};

const tools = ["read", "write", "search"] as const;
const allowed: string[] = ["read", "search"];
console.log(JSON.stringify(tools.filter(name => allowed.includes(name))));
console.log(tools.find(name => name === "write"), tools.findIndex(name => name === "search"));
console.log(tools.some(name => name.length === 4), tools.some(name => name.length === 20));
console.log(tools.find(() => false), tools.findIndex(() => false));

const mixed: readonly [number, string, boolean] = [7, "eight", true];
console.log(JSON.stringify(mixed.filter(value => typeof value === "string")));
console.log(mixed.find(value => typeof value === "string"));
console.log(mixed.findIndex(value => typeof value === "boolean"));
console.log(mixed.some(value => typeof value === "number"));

const values: [number, number, number] = [1, 2, 3];
console.log(JSON.stringify(values.filter((value, index) => {
  if (index === 0) {
    values[0] = 10;
    values[1] = 20;
  }
  return index !== 2;
})));
let visited = "";
console.log(values.find((value, index) => {
  visited += String(index);
  if (index === 0) values[1] = 30;
  if (index === 1) values[1] = 40;
  return index === 1;
}), visited);
visited = "";
console.log(values.findIndex((value, index) => {
  visited += String(index);
  return value === 40;
}), visited);
visited = "";
console.log(values.some((value, index) => {
  visited += String(index);
  return value;
}), visited);

let evaluation = "";
function receiver(): [number, number] { evaluation += "R"; return [4, 5]; }
function callback(): (value: number, index: number) => boolean {
  evaluation += "C";
  return (value, index) => { evaluation += String(index); return value > 0; };
}
console.log(JSON.stringify(receiver().filter(callback())), evaluation);

let owner: [number, number] = [50, 60];
const previous = owner;
function replaceBinding(): (value: number) => boolean {
  owner = [70, 80];
  previous[1] = 90;
  return value => value > 0;
}
console.log(JSON.stringify(owner.filter(replaceBinding())), owner[0]);

const object = { count: 1 };
const objects: [typeof object, typeof object] = [object, object];
const selected = objects.filter(() => true);
console.log(selected[0] === object, objects.find(() => true) === object);
object.count = 2;
console.log(selected[1]!.count);

const optional: [number | undefined, number] = [undefined, 9];
console.log(JSON.stringify(optional.filter(value => value !== undefined)));
console.log(optional.find(value => value !== undefined));
console.log(JSON.stringify(optional.filter(Boolean)));

const empty: [] = [];
let calls = 0;
console.log(JSON.stringify(empty.filter(() => { calls++; return true; })));
console.log(empty.find(() => { calls++; return true; }));
console.log(empty.findIndex(() => { calls++; return true; }));
console.log(empty.some(() => { calls++; return true; }), calls);

try {
  tools.filter((value, index) => {
    if (index === 1) throw new Error(value);
    return true;
  });
} catch (error) { if (error instanceof Error) console.log(error.message); }

function generic<T>(value: T): T[] {
  const pair: [T, T] = [value, value];
  return pair.filter((_, index) => index === 1);
}
console.log(JSON.stringify(generic(12)), JSON.stringify(generic("thirteen")));

const quests = [
  { id: "spring", season: 0, count: 1 },
  { id: "summer", season: 1, count: 2 },
] as const;
const foundQuest = quests.find(quest => quest.season === 1);
console.log(foundQuest === undefined ? "missing" : JSON.stringify(foundQuest));
console.log(JSON.stringify(quests.filter(quest => quest.count > 0)));
console.log(quests.findIndex(quest => quest.id === "spring"));

const truthy: [number, string, boolean, null, undefined] = [0, "text", false, null, undefined];
console.log(JSON.stringify(truthy.filter(Boolean)));
console.log(truthy.find(value => value), truthy.findIndex(value => value));
console.log(truthy.some(value => value));
