// Object literals whose fields start as empty objects, used as maps the
// program adds keys to, including chained assignment into two of them.
function index(entries) {
  const table = {
    first: {},
    second: {},
    all: {},
    lists: { first: [], second: [], all: [] },
  };
  function add(entry) {
    if (entry.many) {
      table.lists[entry.group].push(entry.name);
      table.lists["all"].push(entry.name);
    } else {
      table[entry.group][entry.name] = table["all"][entry.name] = entry;
    }
  }
  entries.forEach(add);
  return table;
}
const table = index([
  { group: "first", name: "a" },
  { group: "second", name: "b" },
  { group: "first", name: "c", many: true },
  { group: "second", name: "a" },
]);
console.log(Object.keys(table.first), Object.keys(table.second), Object.keys(table.all), table.lists);
console.log(table.all.a === table.second.a, table.first.a.group, table.all.b.name, "c" in table.first);
console.log(JSON.stringify(table));

function counters(words) {
  const result = { seen: {}, firstAt: {} };
  words.forEach((word, position) => {
    result.seen[word] = (result.seen[word] || 0) + 1;
    if (!(word in result.firstAt)) result.firstAt[word] = position;
  });
  return result;
}
console.log(JSON.stringify(counters(["x", "y", "x", "z", "y", "x"])));

const settings = { values: {}, names: {} };
const key = String(Math.round(1.6));
settings.values[key] = 2;
settings["names"][key + "!"] = settings.values[key] * 10;
delete settings.values[key];
console.log(JSON.stringify(settings), Object.keys(settings.values).length);
