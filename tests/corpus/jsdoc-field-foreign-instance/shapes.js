class Attribute {
  constructor() {
    this.arr = null;
  }
}
class BufferAttribute extends Attribute {
  constructor() {
    super();
    this.count = 1;
  }
}
class Holder {
  /** @type {BufferAttribute | undefined} */
  item;
}
class ConstructedHolder {
  constructor() {
    /** @type {BufferAttribute | undefined} */
    this.slot = new BufferAttribute();
  }
}
class Interleaved {
  constructor() {
    this.stride = 3;
  }
}
module.exports = { Attribute, BufferAttribute, ConstructedHolder, Holder, Interleaved };
