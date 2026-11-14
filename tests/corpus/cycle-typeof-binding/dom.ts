import { describe, early } from "./lib.js";

export class Node {
  nodeName: string;
  constructor(name: string) {
    this.nodeName = name;
  }
  describe(): string {
    return describe(this);
  }
}

export class Document extends Node {
  title = "untitled";
  constructor() {
    super("#document");
  }
}

console.log("before the declaration: " + early());
export const document: Document = new Document();
console.log("after the declaration: " + early());
