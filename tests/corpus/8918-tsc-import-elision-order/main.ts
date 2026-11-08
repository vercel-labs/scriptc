// @tsc-emit
// This project's tsconfig.json does not set verbatimModuleSyntax, so it is
// compiled the way tsc compiles it: an import whose bindings are never used
// as values is dropped, and its module is not loaded unless another import
// loads it. Every module prints a line when it is evaluated.
import { Shape } from "./shape.js";
import { unusedHelper } from "./unused.js";
import { type Tag } from "./tag.js";
import {} from "./empty.js";
import "./effect.js";
import Config, { used, Kind } from "./mixed.js";
import * as shapes from "./shapes-ns.js";
import * as live from "./live-ns.js";
import { shadowed } from "./shadowed.js";
import { queried } from "./queried.js";
import { Base } from "./base.js";
import { Contract } from "./contract.js";
import { late } from "./late.js";
import Unused, { alsoUsed } from "./partial.js";
import { leaf } from "./leaf.js";
import { aliased } from "./aliases.js";

export { Shape as PublicShape };
export { relayed } from "./relay.js";
export { RelayType } from "./relay-types.js";
export * from "./star.js";

class Derived extends Base implements Contract {
  describe(): string {
    return `derived:${this.base()}`;
  }
}

function shadow(): number {
  const shadowed = 7;
  return shadowed;
}

function later(): number {
  return late + 1;
}

const shape: Shape = { sides: 4 };
const tag: Tag = "t";
const config: Config = { name: "c" };
const kind: Kind = "k";
const point: shapes.Point = { x: 1, y: 2 };
const copy: typeof queried = 5;
console.log("main", shape.sides, tag, config.name, kind, point.x + point.y, copy);
console.log(used(), live.value, shadow(), new Derived().describe(), later(), alsoUsed);
console.log(leaf, aliased);
