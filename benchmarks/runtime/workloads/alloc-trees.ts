// Allocation-heavy code: binary trees built and discarded, plus a
// reducer that produces immutable state updates with object spread.
class TreeNode {
  readonly left: TreeNode | null;
  readonly right: TreeNode | null;
  constructor(left: TreeNode | null, right: TreeNode | null) {
    this.left = left;
    this.right = right;
  }
  check(): number {
    return 1 + (this.left === null ? 0 : this.left.check()) + (this.right === null ? 0 : this.right.check());
  }
}
function build(depth: number): TreeNode {
  return depth === 0 ? new TreeNode(null, null) : new TreeNode(build(depth - 1), build(depth - 1));
}

interface State {
  count: number;
  total: number;
  last: string;
  history: number[];
}
interface Action {
  type: string;
  amount: number;
}
function reduce(state: State, action: Action): State {
  if (action.type === "add") return { ...state, count: state.count + 1, total: state.total + action.amount, last: action.type };
  if (action.type === "reset") return { ...state, total: 0, last: action.type, history: [...state.history.slice(-4), state.total] };
  return { ...state, last: action.type };
}

const scale = Number(process.argv[2] ?? "1");
const maxDepth = 14;
let checks = 0;
for (let depth = 4; depth <= maxDepth; depth += 2) {
  const iterations = Math.floor((1 << (maxDepth - depth + 4)) * scale);
  for (let i = 0; i < iterations; i++) checks += build(depth).check();
}
const longLived = build(maxDepth);
let state: State = { count: 0, total: 0, last: "", history: [] };
for (let i = 0; i < Math.floor(300000 * scale); i++) {
  state = reduce(state, { type: i % 97 === 0 ? "reset" : i % 3 === 0 ? "noop" : "add", amount: i % 13 });
}
console.log("checks", checks, "long", longLived.check(), "state", state.count, state.total, state.history.join(","));
