// An instance enters a union through an arm that is a superclass of its class, becomes an
// untyped value, passes `instanceof` of its own class and is converted to that class or null.
// The capsule made for it names the arm's class; the conversion reads the instance's own.
class Base {}

class TNode extends Base {
  tag(): string {
    return 'node';
  }
}

type U = Base | string | null;

function make(): U {
  return new TNode();
}

function asNode(v: unknown): TNode | null {
  return v instanceof TNode ? v : null;
}

const node = asNode(make());
console.log(node === null ? 'null' : node.tag());
