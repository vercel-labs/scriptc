class Item {
  label = "item";
}
class Left extends Item {
  value = 3;
}
class Right extends Item {
  value = 7;
}
function select(items: Item[]): Left | undefined {
  let result: Left | undefined;
  for (const item of items) {
    if (item instanceof Left) result = item;
  }
  return result;
}
function lookup(items: Map<string, Item>, key: string): Left | undefined {
  const item = items.get(key);
  return item instanceof Left ? item : undefined;
}
function consume(item: Left): number {
  item.value++;
  return item.value;
}
function visit(item: Item): number {
  return item instanceof Left ? consume(item) : 0;
}
function score(items: Item[]): number {
  const item = items[0];
  const selected = item instanceof Left || item instanceof Right;
  return selected ? item.value : item.label.length;
}
function captured(items: Item[]): () => Left | undefined {
  let item = items[0];
  return () => {
    if (item instanceof Left) {
      const result: Left = item;
      item = items[1];
      return result;
    }
    return undefined;
  };
}
const left = new Left();
const items: Item[] = [left, new Right(), new Item()];
const table = new Map<string, Item>([["left", left], ["right", items[1]]]);
console.log(select(items) === left, lookup(table, "left") === left);
console.log(lookup(table, "right"), lookup(table, "absent"), select([]));
console.log(visit(items[0]), visit(items[1]), visit(items[10]));
console.log(left.value, score(items), score([new Right()]), score([new Item()]));
const next = captured(items);
console.log(next() === left, next());
try {
  score([]);
} catch (error) {
  console.log(error instanceof TypeError);
}
