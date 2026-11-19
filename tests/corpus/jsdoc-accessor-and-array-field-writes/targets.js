class Texture {
  constructor() { this.renderTarget = null; this.label = "texture"; }
  /** @returns {Texture} */
  clone() { return new Texture().copy(this); }
  /** @param {Texture} source */
  copy(source) { this.label = source.label; return this; }
}
class DepthTexture extends Texture {
  constructor() { super(); this.isDepthTexture = true; this.compareFunction = null; }
}
class Uniform {
  /** @param {number} value */
  constructor(value) { this.value = value; }
  clone() { return new Uniform(this.value); }
}
export class Target {
  constructor() {
    this._depth = null;
    /** @type {Array<Uniform>} */
    this.uniforms = [];
  }
  /** @param {?DepthTexture} current */
  set depthTexture(current) {
    if (current !== null && current.renderTarget === null) current.renderTarget = this;
    this._depth = current;
  }
  /** @type {?DepthTexture} */
  get depthTexture() { return this._depth; }
  /** @param {Target} source */
  copy(source) {
    if (source.depthTexture !== null) {
      const depthTexture = source.depthTexture.clone();
      depthTexture.renderTarget = null;
      this.depthTexture = depthTexture;
    }
    this.uniforms.length = 0;
    for (const uniform of source.uniforms) {
      if (Array.isArray(uniform)) this.uniforms.push(uniform.map((u) => u.clone()));
      else this.uniforms.push(uniform.clone());
    }
    return this;
  }
}
export function run() {
  const a = new Target();
  a.depthTexture = new DepthTexture();
  a.uniforms.push(new Uniform(1));
  const b = new Target().copy(a);
  const d = b.depthTexture;
  console.log(d === null ? "none" : d.constructor.name, d !== null && d.renderTarget === b, d !== null && d.label);
  console.log(b.uniforms.length, b.uniforms[0].value);
}

class DepthSlot {
  /** @type {?DepthTexture} */
  _owned;
}

export class InheritedTarget extends DepthSlot {
  /** @param {?DepthTexture} current */
  set texture(current) {
    this._owned = current;
  }
  /** @type {?DepthTexture} */
  get texture() {
    return this._owned;
  }
}

export function inheritedSlot() {
  const target = new InheritedTarget();
  target.texture = new Texture();
  const held = target.texture;
  console.log(held === null ? "none" : held.constructor.name, held !== null && held.label);
  target.texture = new DepthTexture();
  console.log(target.texture.constructor.name, target.texture.isDepthTexture);
}

export function readBack() {
  const holder = new Target();
  holder.depthTexture = new DepthTexture();
  const copied = new Target().copy(holder);
  const texture = copied.depthTexture;
  console.log(texture === null ? "none" : texture.constructor.name, texture !== null && texture.isDepthTexture);
  copied.depthTexture = null;
  console.log(copied.depthTexture === null);
  copied.uniforms.push(new Uniform(4));
  copied.uniforms.push(/** @type {any} */ ([new Uniform(5), new Uniform(6)]));
  const grouped = new Target().copy(copied);
  const second = grouped.uniforms[1];
  console.log(grouped.uniforms.length, Array.isArray(second), Array.isArray(second) && second.map((u) => u.value).join("+"));
}
