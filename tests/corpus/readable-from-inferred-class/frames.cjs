class Frames {
  constructor(items) {
    this.items = items;
  }
  [Symbol.asyncIterator]() {
    return this.frames();
  }
  async *frames() {
    for (const item of this.items) yield `<${item}>`;
  }
}

class Inner {
  make(items) {
    return new Frames(items);
  }
}

class Outer {
  constructor() {
    this.inner = new Inner();
  }
}

module.exports = { Outer };
