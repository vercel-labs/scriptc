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

// A nested function's `this` is its own, never the class's: a name that
// matches the class's generic method there does not make the member need a
// typed receiver, so the view still runs with a borrowed receiver. An arrow
// keeps the enclosing `this`, so a read through one is the class's own.
class Borrower {
  appendChild<T extends Borrower>(child: any): T {
    return child as T;
  }
  readThroughFunction(): string {
    const call = function (this: any) {
      return this.appendChild();
    };
    return call.call({ appendChild: () => "helper" }) + ":" + (this as any).tag;
  }
  readThroughArrow(): string {
    const read = (): string => String(this.appendChild(new Borrower()) !== undefined);
    return read() + ":" + ((this as any).tag ?? "instance");
  }
}

const borrower = new Borrower();
const borrowedView = Object.getPrototypeOf(borrower as any);
console.log(borrowedView.readThroughFunction.call({ tag: "borrowed" }));
console.log(borrowedView.readThroughArrow.call(borrower));

// A nested class's field initializer is a new `this`, even when it holds an
// arrow: the inner instance's `appendChild` is not the outer class's, so the
// member keeps the dynamic view and a borrowed receiver still runs.
class Outer {
  appendChild<T extends Outer>(child: any): T {
    return child as T;
  }
  run(): string {
    class Inner {
      appendChild(): string {
        return "inner";
      }
      helper: () => string = () => this.appendChild();
      read(): string {
        return String(typeof this.helper) + ":" + this.helper();
      }
    }
    return new Inner().read() + ":" + (this as any).tag;
  }
}

const outerView = Object.getPrototypeOf(new Outer() as any);
console.log(outerView.run.call({ tag: "borrowed" }));
