// JavaScript class methods that read themselves as a value inside their
// own body: i18next's `instance.createInstance = I18n.createInstance`.
// The value is the same function every other read of the method sees.

class Registry {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
    /** @type {((name: string) => Registry) | undefined} */
    this.create = undefined;
  }

  /** @param {string} name */
  static create(name) {
    const registry = new Registry(name);
    registry.create = Registry.create;
    return registry;
  }

  describe() {
    return `${this.name} ${typeof this.create}`;
  }
}

const a = Registry.create('a');
const b = a.create?.('b') ?? a;
console.log(a.describe(), b.describe());
console.log(a.create === Registry.create, b.create === a.create);
