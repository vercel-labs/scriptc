// `value instanceof Target` for objects whose prototype the program chose (the chain a class
// test walks) and for a Proxy, which has its target's prototype.
class Base {
  protected isBase(): boolean {
    return true;
  }
}
class Leaf extends Base {
  n: number = 2;
}
class Other {
  o: number = 3;
}
class GNode<Form = unknown> extends Base {
  form: Form | null = null;
}

const values: Array<[string, unknown]> = [
  ['created from an object', Object.create({a: 1})],
  ['created from a created one', Object.create(Object.create({a: 1}))],
  ['set to an object', Object.setPrototypeOf({a: 1}, {b: 2})],
  ['created from null', Object.create(null)],
  ['proxy of an object', new Proxy({a: 1}, {})],
  ['proxy of a created one', new Proxy(Object.create({a: 1}), {})],
  ['a Leaf', new Leaf()],
  ['an Other', new Other()],
];

const targets: Array<[string, (v: unknown) => boolean]> = [
  ['Error', (v: unknown): boolean => v instanceof Error],
  ['Array', (v: unknown): boolean => v instanceof Array],
  ['Map', (v: unknown): boolean => v instanceof Map],
  ['Date', (v: unknown): boolean => v instanceof Date],
  ['Base', (v: unknown): boolean => v instanceof Base],
  ['Leaf', (v: unknown): boolean => v instanceof Leaf],
  ['Other', (v: unknown): boolean => v instanceof Other],
  ['GNode', (v: unknown): boolean => v instanceof GNode],
];

for (const [target, ask] of targets) {
  for (const [label, value] of values) {
    let line = target + ' <- ' + label + ': ';
    try {
      line += ask(value);
    } catch (x) {
      line += 'THROWS ' + (x instanceof Error ? x.message : 'a value');
    }
    console.log(line);
  }
}
