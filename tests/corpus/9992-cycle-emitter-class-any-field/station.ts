import { EventEmitter } from "node:events";
import { summarize } from "./relay.ts";

export class Station extends EventEmitter {
  name: string;
  extra: any;
  log: any[];
  constructor(name: string) {
    super();
    this.name = name;
    this.extra = null;
    this.log = [name.length];
  }
  toString(): string {
    return summarize(this);
  }
}
