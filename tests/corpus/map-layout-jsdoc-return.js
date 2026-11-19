// A Map built empty and returned where JSDoc declares a concrete layout:
// the checked-dynamic copy rebuilds the declared key and value slots, and
// the caller reads the map it returned.
class Option {
  constructor(name) {
    this.name = name;
  }
}
class Command {
  constructor(name) {
    this.name = name;
  }
}
/**
 * @param {(Command | Option)[]} items
 * @returns {Map<string, (Command | Option)[]>}
 */
function groupItems(items) {
  const result = new Map();
  if (!result.has("all")) result.set("all", []);
  for (const item of items) result.get("all").push(item);
  return result;
}
const grouped = groupItems([new Option("verbose"), new Command("run")]);
console.log(grouped.size, grouped.get("all").length);
const all = grouped.get("all");
const names = [];
for (let i = 0; i < all.length; i++) names.push(all[i].name);
console.log(names.join(","));
console.log([...grouped.keys()].join("|"));
