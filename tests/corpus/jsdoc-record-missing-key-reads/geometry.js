class BufferAttribute {
  /** @param {number} count */
  constructor(count) {
    this.count = count;
  }
}
class InterleavedAttribute {
  constructor() {
    this.stride = 3;
  }
}
class Geometry {
  constructor() {
    /** @type {Object<string,(BufferAttribute|InterleavedAttribute)>} */
    this.attributes = {};
  }
  describe() {
    const position = this.attributes.position;
    if (position !== undefined) console.log("position", position.constructor.name);
    const tangent = this.attributes.tangent;
    if (tangent !== undefined) console.log("tangent", tangent.constructor.name);
    else console.log("no tangent");
    const normal = this.attributes.normal;
    console.log(normal === undefined, typeof normal);
    console.log(this.attributes.uv === undefined, "uv" in this.attributes);
  }
}
export function run() {
  const geometry = new Geometry();
  geometry.describe();
  geometry.attributes.position = new BufferAttribute(3);
  geometry.attributes.tangent = new InterleavedAttribute();
  geometry.describe();
  delete geometry.attributes.tangent;
  geometry.describe();
}
