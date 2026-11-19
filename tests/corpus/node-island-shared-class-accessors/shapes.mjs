export class Box {
  constructor(name) {
    this.name = name;
    this.items = [];
    this.title = "";
  }
  get size() {
    return this.items.length;
  }
  get label() {
    return `${this.name}:${this.title}`;
  }
  set label(value) {
    this.title = value.toUpperCase();
  }
  set only(value) {
    this.title = `only ${value}`;
  }
  add(item) {
    this.items.push(item);
    return this;
  }
}

export class Tagged extends Box {
  constructor(name, tag) {
    super(name);
    this.tag = tag;
  }
  get size() {
    return super.size * 10;
  }
  get tagged() {
    return `#${this.tag}`;
  }
}

export class Leaf extends Tagged {}

export function make(kind, name) {
  if (kind === "leaf") return new Leaf(name, "leaf");
  return kind === "tagged" ? new Tagged(name, "t") : new Box(name);
}
