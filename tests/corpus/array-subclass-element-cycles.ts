// A class that extends Array whose elements can lead back to it only
// through a field of plain array type (TreeNode.kids holds a Kids, typed as
// an array of TreeNode): its instances carry the collector header that
// arrays of its element type carry, so the collector can visit them through
// that field. Forest's elements are Kids instances, which carry one too.
class Kids extends Array<TreeNode> {
  label = "kids";
  total(): number {
    let sum = 0;
    for (const kid of this) sum += kid.size();
    return sum;
  }
}

class TreeNode {
  kids = new Kids();
  value: number;
  constructor(value: number) {
    this.value = value;
  }
  size(): number {
    return 1 + this.kids.total();
  }
}

class Forest extends Array<Kids> {
  name = "forest";
}

function grow(depth: number): TreeNode {
  const node = new TreeNode(depth);
  if (depth > 0) for (let i = 0; i < 3; i++) node.kids.push(grow(depth - 1));
  return node;
}

// Garbage cycles through the field of array type make the collector run
// while the trees are alive.
function churn(rounds: number): number {
  let made = 0;
  for (let i = 0; i < rounds; i++) {
    const node = new TreeNode(i);
    node.kids.push(node);
    made++;
  }
  return made;
}

let checks = 0;
for (let round = 0; round < 20; round++) {
  checks += grow(4).size();
  churn(500);
}
console.log(checks);

const forest = new Forest();
for (let i = 0; i < 4; i++) forest.push(grow(2).kids);
churn(5000);
let leaves = 0;
for (const kids of forest) leaves += kids.total();
console.log(forest.name, forest.length, leaves, forest[0]!.label, forest[0] instanceof Kids);
