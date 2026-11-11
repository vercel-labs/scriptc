import { afterAll, expect, test } from "vitest";
import * as ts from "../ts7/adapter.js";
import { closeSourceParser, parseSourceFile } from "../ts7/source-parser-node.js";
import { extendsElementOf } from "../heritage-elements.js";
import { classHierarchyOf, constructionReads } from "./construction-reads.js";

afterAll(closeSourceParser);

/** The fields of class `name` that construction can read before their
 * assignment, with every class of `source` resolved by name. */
function early(source: string, name: string): string[] {
  const file = parseSourceFile("classes.ts", source, "ts");
  const classes = new Map<string, ts.ClassLikeDeclaration>();
  ts.walkPreorder(file, (node) => {
    if (ts.isClassDeclaration(node) && node.name) classes.set(node.name.text, node);
    return undefined;
  });
  const resolve = (heritage: ts.Expression): ts.ClassLikeDeclaration | null | undefined =>
    ts.isIdentifier(heritage) ? (classes.get(heritage.text) ?? null) : undefined;
  const baseOf = (decl: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration | null | undefined => {
    const heritage = extendsElementOf(decl)?.expression;
    return heritage === undefined ? null : resolve(heritage);
  };
  const decl = classes.get(name);
  if (!decl) throw new Error(`fixture has no class ${name}`);
  const bases: ts.ClassLikeDeclaration[] = [];
  for (let base = baseOf(decl); base; base = baseOf(base)) bases.push(base);
  const reads = constructionReads(decl, bases, classHierarchyOf([file], resolve));
  return decl.members.nodes
    .filter(ts.isPropertyDeclaration)
    .map((member) => ts.getTextOfNode(member.name))
    .filter((field) => reads.early(field))
    .sort();
}

test("a method the constructor calls reads fields, the constructor itself does not", () => {
  const source = `
    class Settings {
      a: number; b: number; c: number; d: number;
      constructor() { this.a = 1; this.report(); this.b = this.a; this.c = 2; this.d = 3; }
      report(): number { return this.a + this.b + this.helper(); }
      helper(): number { return this.c; }
      unrelated(): number { return this.d; }
    }`;
  expect(early(source, "Settings")).toEqual(["b", "c"]);
});

test("a call counts for the fields assigned after it", () => {
  const source = `
    class Ordered {
      first = 1;
      second = this.sum();
      third = 3;
      fourth: number;
      fifth: number;
      constructor() { this.fourth = 4; this.sum(); this.fifth = 5; }
      sum(): number { return this.first + this.second + this.third + this.fourth + this.fifth; }
    }`;
  expect(early(source, "Ordered")).toEqual(["fifth", "fourth", "second", "third"]);
});

test("a write is not a read", () => {
  const source = `
    class Output {
      stream!: string[]; width!: number;
      constructor() { this.initialize(); }
      initialize(): void { this.stream = []; this.width += 1; }
    }`;
  expect(early(source, "Output")).toEqual(["width"]);
});

test("a base constructor's call reaches the override of a derived class", () => {
  const source = `
    class Base { ready = false; constructor() { this.init(); } init(): void {} }
    class Derived extends Base { size = 5; other = 1; init(): void { console.log(this.size, this.ready); } }
    class Sibling extends Base { other = 2; init(): void { console.log(this.other); } }`;
  expect(early(source, "Derived")).toEqual(["size"]);
  expect(early(source, "Sibling")).toEqual(["other"]);
  // The base's own field is assigned before its constructor makes the call.
  expect(early(source, "Base")).toEqual([]);
});

test("a field initializer's call and a super call are followed", () => {
  const source = `
    class Sup { v = this.init(); init(): number { return 1; } }
    class Mid extends Sup { m = 1; init(): number { return this.m; } }
    class Sub extends Mid { w = 10; init(): number { return super.init() + this.w; } }`;
  expect(early(source, "Sub")).toEqual(["w"]);
  expect(early(source, "Mid")).toEqual(["m"]);
  expect(early(source, "Sup")).toEqual([]);
});

test("an accessor read and a callback that captures the instance are followed", () => {
  const source = `
    class Model {
      constructor(items: number[]) {
        console.log(this.display);
        items.forEach(() => this.touch());
        const own = function (this: { other: number }) { return this.other; };
      }
      get display(): string { return "model"; }
      touch(): void {}
    }
    class Titled extends Model {
      title = "t"; count = 0; other = 1; idle = 2;
      get display(): string { return this.title; }
      touch(): void { [1].map(() => this.count++); }
    }`;
  expect(early(source, "Titled")).toEqual(["count", "title"]);
});

test("a computed member of this can read anything assigned later", () => {
  const source = `
    class Dynamic {
      a = 1;
      b = this.run("c");
      c = 3;
      run(key: "a" | "c"): number { return this[key]; }
    }`;
  expect(early(source, "Dynamic")).toEqual(["b", "c"]);
});

test("a class whose base is computed may extend any class", () => {
  const source = `
    class Base { constructor() { this.init(); } init(): void {} }
    function mixin(base: typeof Base) { return class extends base {}; }
    class Mixed extends mixin(Base) { flag = true; init(): void { console.log(this.flag); } }
    class Plain extends Base { flag = false; plain = 1; }`;
  expect(early(source, "Plain")).toEqual(["flag"]);
});

test("a field holding a function is followed when construction calls it", () => {
  const source = `
    class Hooks {
      onReady = (): number => this.count;
      onIdle = (): number => this.idle;
      count = 0; idle = 1; label: string;
      constructor() { this.onReady(); this.label = "y"; }
    }
    class Eager {
      onReady = (): number => this.count;
      ready = this.onReady();
      count = 0;
    }`;
  expect(early(source, "Hooks")).toEqual([]);
  expect(early(source, "Eager")).toEqual(["count"]);
});

test("reading a method does not run it, calling it and reading an accessor do", () => {
  const source = `
    class Account {
      action = this.deposit;
      label = this.title;
      total = this.sum();
      rate = 2; name = "n"; balance = 0;
      deposit(amount: number): number { return amount * this.rate; }
      get title(): string { return this.name; }
      sum(): number { return this.balance; }
    }`;
  expect(early(source, "Account")).toEqual(["balance", "name"]);
});

test("call, apply, bind and a method handed to a call can run the method", () => {
  const source = `
    class Explicit {
      constructor(items: number[]) {
        this.viaCall.call(this);
        this.viaApply.apply(this, []);
        const bound = this.viaBind.bind(this);
        items.forEach(this.viaArgument, this);
        const stored = this.onlyStored;
        this.a = 1; this.b = 2; this.c = 3; this.d = 4; this.e = 5;
      }
      a: number; b: number; c: number; d: number; e: number;
      viaCall(): number { return this.a; }
      viaApply(): number { return this.b; }
      viaBind(): number { return this.c; }
      viaArgument(): number { return this.d; }
      onlyStored(): number { return this.e; }
    }`;
  expect(early(source, "Explicit")).toEqual(["a", "b", "c", "d"]);
});

test("a computed write through this is not a read", () => {
  const source = `
    const key = Symbol("key");
    class Keyed {
      [key]: number; plain: number;
      constructor() { this.touch(); this[key] = 1; this.plain = 2; }
      touch(): void {}
    }`;
  expect(early(source, "Keyed")).toEqual([]);
});
