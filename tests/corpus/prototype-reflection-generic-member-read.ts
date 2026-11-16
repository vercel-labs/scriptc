// A prototype view's member runs with the class's own `this`. The view is
// built by lowering each member a second time over a checked-dynamic
// receiver; a member that reads a generic method through `this` cannot run
// that way (the dynamic lookup has no specialization to hand out), so it
// keeps its compiled, receiver-checked form and the generic call inside it
// lowers at the call site, as the typed source does.
class Tree {
  kids: Tree[] = [];
  appendChild<T extends Tree>(child: any): T {
    this.kids.push(child as Tree);
    return child as T;
  }
  insertBefore(child: any, ref?: any): Tree {
    if (ref === null) return this.appendChild(child);
    return child as Tree;
  }
}

const tree = new Tree();
const untyped: any = tree;
const view = Object.getPrototypeOf(untyped);
const insert = view.insertBefore;
const appended = insert.call(tree, new Tree(), null);
console.log(tree.kids.length, appended === tree.kids[0], typeof insert);

const descriptor = Object.getOwnPropertyDescriptor(view, "insertBefore")!;
console.log(typeof descriptor.value, descriptor.writable);
const second = new Tree();
descriptor.value.call(second, new Tree(), null);
console.log(second.kids.length);

// A member that reads only its own fields keeps the dynamic-receiver view.
class Counter {
  count = 0;
  bump(): number {
    this.count = this.count + 1;
    return this.count;
  }
}
const counter = new Counter();
const counterView = Object.getPrototypeOf(counter as any);
const bump = counterView.bump;
console.log(bump.call(counter), bump.call(counter), counter.count);
