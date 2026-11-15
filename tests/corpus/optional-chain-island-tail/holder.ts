import { EventEmitter } from "node:events";
import type { Settings } from "settings-kit";

export interface Described {
  describe(): string;
}

export default class Holder extends EventEmitter implements Described {
  config: Settings;
  constructor(options: { config: Settings }) {
    super();
    this.config = options.config;
  }
  describe(): string {
    return this.config.describe();
  }
  settings(): Settings {
    return this.config;
  }
}
