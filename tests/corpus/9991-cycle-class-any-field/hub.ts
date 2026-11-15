import { label } from "./helper.ts";

export default class Hub {
  name: string;
  meta: any;
  constructor(name: string) {
    this.name = name;
    this.meta = name.length;
  }
  describe(): string {
    return label(this);
  }
}
