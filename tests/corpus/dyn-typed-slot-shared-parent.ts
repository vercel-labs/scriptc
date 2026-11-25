// A typed slot's adoption converts a shared parent before the child the
// parent's two fields are the only holders of. The child has to stay alive
// through the parent's conversion so its own conversion reaches it, and the
// two fields stay one object on both sides.
type Cell = { value: number; left: Cell | undefined; right: Cell | undefined };

const root: any = { value: 1 };
root.left = { value: 2, left: undefined, right: undefined };
root.right = root.left;
const holder: any = root;
const typed: Cell = root;
typed.left!.value = 7;
console.log("fields:", typed.left === typed.right, root.left === root.right);
console.log("value:", typed.left!.value, root.left!.value, holder.left!.value);
console.log("same:", typed.left === root.left, root.right === root.left);
