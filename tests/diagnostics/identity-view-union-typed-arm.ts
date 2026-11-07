// A recursive union that holds a dictionary keeping identity is the checked-dynamic value;
// an arm with a typed representation of its own (a Map) cannot join it.
type Bag = { [key: string]: Node };
type Node = number | Map<string, Node> | Node[] | Bag;

const fixed = { n: 1 };
const bag: Bag = fixed;
bag.more = [2];
function count(value: Node): number {
  if (typeof value === "number") return 1;
  if (Array.isArray(value)) return value.length;
  if (value instanceof Map) return value.size;
  return Object.keys(value).length;
}
console.log(count(bag), count(new Map<string, Node>([["k", bag]])), count([bag, 3]), JSON.stringify(fixed));
