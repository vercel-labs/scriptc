// A recursive record that declares a generic method compiles. Erasing the
// method's own type parameters does not depend on any enclosing generic
// binding, so the record still closes its recursive knot: a parent
// interface whose child is a subinterface declaring a generic method, and a
// list node whose generic method sits beside a self-referencing field.

interface Message<T = unknown> {
  content: string;
  details?: T;
}

interface TreeNode {
  name: string;
  child?: SendingNode;
}

interface SendingNode extends TreeNode {
  send<T = unknown>(message: Message<T>): string;
}

interface ListNode {
  value: number;
  next: ListNode | null;
  map<U>(f: (value: number) => U): string;
}

function describe(node: TreeNode): string {
  const inner = node.child;
  return inner ? `${node.name} > ${describe(inner)}` : node.name;
}

function leaf(name: string): SendingNode {
  return { name, send: () => `${name} got a message` };
}

const tree: SendingNode = {
  name: "root",
  child: { name: "middle", child: leaf("leaf"), send: () => "middle got a message" },
  send: () => "root got a message",
};
console.log(describe(tree));
console.log(tree.send({ content: "hello" }));
const middle = tree.child;
if (middle !== undefined) console.log(middle.send({ content: "hi", details: 42 }));

function cons(value: number, next: ListNode | null): ListNode {
  return { value, next, map: () => `node ${value}` };
}

let list: ListNode | null = cons(1, cons(2, cons(3, null)));
const values: number[] = [];
let labels = "";
while (list !== null) {
  values.push(list.value);
  labels += `[${list.map((v) => v * 2)}]`;
  list = list.next;
}
console.log(values.join(","), labels);
