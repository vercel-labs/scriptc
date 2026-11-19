export class Object3D {
  constructor(name) {
    this.name = name;
    this.children = [];
  }
  /**
   * @param {Object3D} source
   * @param {boolean} [recursive]
   * @returns {Object3D}
   */
  copy(source, recursive = true) {
    this.name = source.name;
    if (recursive) for (const child of source.children) this.children.push(child.clone());
    return this;
  }
  clone() {
    return new this.constructor(this.name).copy(this);
  }
  // The base names its parameters only in a comment.
  raycast(/* raycaster, intersects */) {}
}

export class Mesh extends Object3D {
  constructor(name) {
    super(name);
    this.material = "basic";
  }
  /**
   * @param {Mesh} source
   * @param {boolean} recursive
   * @returns {this}
   */
  copy(source, recursive) {
    super.copy(source, recursive);
    this.material = source.material;
    return this;
  }
  /**
   * @param {string} raycaster
   * @param {Array<string>} intersects
   */
  raycast(raycaster, intersects) {
    intersects.push(`${raycaster}:${this.name}`);
  }
}

export class Points extends Object3D {
  /**
   * @param {string} raycaster
   * @param {Array<string>} intersects
   * @param {number} [limit]
   */
  raycast(raycaster, intersects, limit) {
    intersects.push(`${raycaster}:${this.name}:${limit}`);
  }
}

export class Curve {
  /** @returns {number | string} */
  getPoint(/* t, optionalTarget */) {
    return "abstract";
  }
}

export class LineCurve extends Curve {
  /**
   * @param {number} from
   * @param {number} to
   */
  constructor(from, to) {
    super();
    this.from = from;
    this.to = to;
  }
  /**
   * @param {number} t
   * @param {Array<number>} [optionalTarget]
   * @returns {Array<number>}
   */
  getPoint(t, optionalTarget = []) {
    optionalTarget.push(this.from + (this.to - this.from) * t);
    return optionalTarget;
  }
}

export function run() {
  const mesh = new Mesh("cube");
  mesh.material = "standard";
  mesh.children.push(new Mesh("child"));
  const copied = new Mesh("empty").copy(mesh, true);
  console.log(copied.name, copied.material, copied.children.length, copied.children[0].name);
  const shallow = new Mesh("empty").copy(mesh, false);
  console.log(shallow.children.length);
  const cloned = mesh.clone();
  console.log(cloned instanceof Mesh, cloned.material, cloned.children[0] instanceof Mesh);
  /** @type {Object3D} */
  const base = new Object3D("plain");
  base.raycast("ignored", []);
  console.log(new Points("dots").clone() instanceof Points);
}

export function dispatch() {
  /** @type {Object3D[]} */
  const shapes = [new Object3D("root"), new Mesh("mesh"), new Points("points")];
  /** @type {string[]} */
  const hits = [];
  for (const shape of shapes) shape.raycast("ray", hits, 2);
  console.log(hits.join(","));
  /** @type {Curve[]} */
  const curves = [new Curve(), new LineCurve(1, 5)];
  for (const curve of curves) console.log(String(curve.getPoint(0.5)));
  /** @type {Object3D[]} */
  const copies = [new Object3D("a").copy(new Mesh("m")), new Mesh("b").copy(new Mesh("n"), false)];
  console.log(copies.map((c) => `${c.constructor.name}:${c.name}`).join(","));
}
