import { describe, expect, test } from "vitest";
import {
  applyNpmStaticDeclarationProperties,
  applyNpmStaticDeclarationOverloads,
  applyNpmStaticFindReturnWidening,
  npmStaticDeclarationReexports,
  npmStaticRuntimeClassTargets,
  parseNpmStaticDeclarationProperties,
  parseNpmStaticDeclarationOverloads,
} from "./npm-static-declarations.js";

const declarations = `
export class Chainy {
  name(): string;
  name(value: string): this;
  description(): string;
  description(value: string): this;
  description(value: string, argsDescription: Record<string, string>): this;
  tag(): string;
  tag(value: string): this;
  aliases(): string[];
  aliases(values: readonly string[]): this;
  helpOption(flags?: string | boolean, description?: string): this;
  single(): string;
  unsafe(): string;
  unsafe(value: Date): this;
  generic<T>(value: T): T;
  generic(value: string): string;
  parent: Chainy | null;
  optionalParent?: Chainy | null;
  labels: string[];
}
`;

describe("npm-static declaration overload projection", () => {
  test("widens an array find result when JavaScript JSDoc omits undefined", () => {
    const source = `
class Choices {
  constructor() { this.items = []; }
  /** @return {Item} */
  lookup(value) { return this.items.find((item) => item.value === value); }
  /** @return {Item | undefined} */
  already(value) { return this.items.find((item) => item.value === value); }
  /** @return {Item} */
  custom(value) { return this.index.find(value); }
}
`;
    const rewritten = applyNpmStaticFindReturnWidening("index.js", source);
    expect(rewritten).not.toBeNull();
    expect(rewritten!.text).toContain("/** @return {Item | undefined} */\n  lookup(value)");
    expect(rewritten!.text).toContain("/** @return {Item | undefined} */\n  already(value)");
    expect(rewritten!.text).toContain("/** @return {Item} */\n  custom(value)");
  });
  test("extracts only complete representation-safe overload groups", () => {
    const overloads = parseNpmStaticDeclarationOverloads("index.d.ts", declarations);
    expect([...overloads.keys()]).toEqual(["Chainy"]);
    expect([...overloads.get("Chainy")!.keys()]).toEqual(["name", "description", "tag", "aliases", "helpOption"]);
    expect(overloads.get("Chainy")!.get("name")).toEqual([
      { parameters: [], returnType: "string" },
      { parameters: [{ name: "value", type: "string", optional: false }], returnType: "this" },
    ]);
    expect(overloads.get("Chainy")!.get("aliases")).toEqual([
      { parameters: [], returnType: "string[]" },
      { parameters: [{ name: "values", type: "string[]", optional: false }], returnType: "this" },
    ]);
  });

  test("injects overload and implementation JSDoc only into exported matching classes", () => {
    const source = `
class Hidden {
  name(value) { return value === undefined ? "" : this; }
}
class Chainy {
  name(value) { return value === undefined ? "" : this; }
  tag(value) { return value === undefined ? "" : this; }
}
module.exports = { Chainy };
`;
    const rewritten = applyNpmStaticDeclarationOverloads(
      "index.js",
      source,
      parseNpmStaticDeclarationOverloads("index.d.ts", declarations),
    );
    expect(rewritten).not.toBeNull();
    expect(rewritten!.insertions).toHaveLength(2);
    expect(rewritten!.text.match(/@overload/g)).toHaveLength(4);
    expect(rewritten!.text).toContain("@param {string} [value] @returns {string | Chainy}");
    expect(rewritten!.text.slice(source.indexOf("class Hidden"), source.indexOf("class Chainy"))).not.toContain("@overload");
  });

  test("projects only nullable-self properties onto matching constructor null writes", () => {
    const properties = parseNpmStaticDeclarationProperties("index.d.ts", declarations);
    expect(properties).toEqual(new Map([
      ["Chainy", new Map([["parent", "Chainy | null"]])],
    ]));
    const rewritten = applyNpmStaticDeclarationProperties("index.js", `
class Chainy {
  constructor() {
    this.parent = null;
    this.optionalParent = null;
    this.labels = [];
  }
}
module.exports = { Chainy };
`, properties);
    expect(rewritten).not.toBeNull();
    expect(rewritten!.insertions).toHaveLength(1);
    expect(rewritten!.text).toContain("/** @type {Chainy | null} */ this.parent = null;");
    expect(rewritten!.text).not.toContain("@type {Chainy | null} */ this.optionalParent");
    expect(rewritten!.text).not.toContain("@type {string[]}");
  });

  test("projects an array getter overload onto its empty constructor backing field", () => {
    const rewritten = applyNpmStaticDeclarationOverloads("index.js", `
class Chainy {
  constructor() { this._aliases = []; }
  aliases(values) {
    if (values === undefined) return this._aliases;
    this._aliases = values;
    return this;
  }
}
module.exports = { Chainy };
`, parseNpmStaticDeclarationOverloads("index.d.ts", declarations));
    expect(rewritten).not.toBeNull();
    expect(rewritten!.text).toContain("/** @type {string[]} */ this._aliases = [];");
  });

  test("projects safe optional parameters over stricter implementation JSDoc", () => {
    const rewritten = applyNpmStaticDeclarationOverloads("index.js", `
class Chainy {
  /** @param {string | boolean} flags @param {string} [description] @returns {Chainy} */
  helpOption(flags, description) { return this; }
}
module.exports = { Chainy };
`, parseNpmStaticDeclarationOverloads("index.d.ts", declarations));
    expect(rewritten).not.toBeNull();
    expect(rewritten!.text).toContain("@param {string | boolean} [flags]");
    expect(rewritten!.text).toContain("@param {string} [description]");
  });
  test("reports only relative declaration-barrel edges", () => {
    expect(npmStaticDeclarationReexports("esm.d.mts", `
      export * from "./index.js";
      export { Type } from "./types.js";
      export * from "other-package";
    `)).toEqual(["./index.js", "./types.js"]);
  });

  test("binds declaration classes to direct and one-hop runtime exports", () => {
    expect(npmStaticRuntimeClassTargets("index.js", `
      const { Command, Other: Alias } = require("./lib/command.js");
      class Local {}
      exports.Command = Command;
      exports.Alias = Alias;
      exports.Local = Local;
    `, new Set(["Command", "Alias", "Local"]))).toEqual(new Map([
      ["Command", "./lib/command.js"],
      ["Local", null],
    ]));
  });

  test("binds declaration classes through one-hop ESM import/export plumbing", () => {
    expect(npmStaticRuntimeClassTargets("index.js", `
      import { Command, Other as Alias } from "./lib/command.js";
      class Local {}
      export { Command, Alias, Local };
    `, new Set(["Command", "Alias", "Local"]))).toEqual(new Map([
      ["Command", "./lib/command.js"],
      ["Local", null],
    ]));
  });
});
