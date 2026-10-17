export class Crate {
  readonly label: string;
  contents: WeakMap<object, string>;
  constructor(label: string) {
    this.label = label;
    this.contents = new WeakMap();
  }
}
