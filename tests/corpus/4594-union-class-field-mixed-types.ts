// Syntax-tree helpers read and write a field shared by several node classes
// after an `instanceof` test, where some classes declare the field optional
// and others required (or as a subclass), as a compiler's AST accessors do.
class Node {
  kind: string;
  constructor(kind: string) {
    this.kind = kind;
  }
}

class Identifier extends Node {
  text: string;
  constructor(text: string) {
    super("Identifier");
    this.text = text;
  }
}

class ReturnStatement extends Node {
  expression: Node | undefined;
  constructor(expression: Node | undefined) {
    super("ReturnStatement");
    this.expression = expression;
  }
}

class ParenthesizedExpression extends Node {
  depth: number;
  expression: Node;
  constructor(expression: Node) {
    super("ParenthesizedExpression");
    this.depth = 1;
    this.expression = expression;
  }
}

class ExportAssignment extends Node {
  isExportEquals: boolean;
  label: string;
  expression: Node;
  constructor(expression: Node) {
    super("ExportAssignment");
    this.isExportEquals = false;
    this.label = "default";
    this.expression = expression;
  }
}

class VariableDeclaration extends Node {
  name: Identifier;
  initializer: Node | undefined;
  line: number | undefined;
  constructor(name: Identifier, initializer: Node | undefined) {
    super("VariableDeclaration");
    this.name = name;
    this.initializer = initializer;
    this.line = undefined;
  }
}

class PropertyAssignment extends Node {
  name: Node;
  initializer: Node;
  line: number;
  constructor(name: Node, initializer: Node) {
    super("PropertyAssignment");
    this.name = name;
    this.initializer = initializer;
    this.line = 3;
  }
}

function describe(node: Node | undefined): string {
  if (node === undefined) return "-";
  return node instanceof Identifier ? node.text : node.kind;
}

// Reads: each class answers from its own slot; the result is optional.
function getExpression(node: Node): Node | undefined {
  if (node instanceof ReturnStatement || node instanceof ParenthesizedExpression || node instanceof ExportAssignment)
    return node.expression;
  return undefined;
}

function getInitializer(node: Node): Node | undefined {
  if (node instanceof VariableDeclaration || node instanceof PropertyAssignment) return node.initializer;
  return undefined;
}

// Writes: the value is stored into each class's slot.
function setExpression(node: Node, value: Node): boolean {
  if (node instanceof ReturnStatement || node instanceof ParenthesizedExpression || node instanceof ExportAssignment) {
    node.expression = value;
    return true;
  }
  return false;
}

function setInitializer(node: Node, value: Node): boolean {
  if (node instanceof VariableDeclaration || node instanceof PropertyAssignment) {
    node.initializer = value;
    return true;
  }
  return false;
}

const nodes: Node[] = [
  new ReturnStatement(undefined),
  new ReturnStatement(new Identifier("x")),
  new ParenthesizedExpression(new Identifier("y")),
  new ExportAssignment(new Node("ObjectLiteral")),
  new Identifier("z"),
];
for (const node of nodes) {
  const before = describe(getExpression(node));
  const changed = setExpression(node, new Identifier(node.kind.toLowerCase()));
  console.log(node.kind, before, changed, describe(getExpression(node)));
}

// Narrowing the read result works like a narrowed field read.
function initializerText(node: Node): string {
  if (!(node instanceof VariableDeclaration || node instanceof PropertyAssignment)) return "none";
  if (node.initializer === undefined) return "uninitialized";
  return describe(node.initializer) + "/" + node.initializer.kind;
}

const declaration = new VariableDeclaration(new Identifier("a"), undefined);
const property = new PropertyAssignment(new Identifier("b"), new Identifier("init"));
console.log(initializerText(declaration), initializerText(property), initializerText(nodes[0]!));
console.log(setInitializer(declaration, new Identifier("one")), setInitializer(property, new Node("Call")));
console.log(initializerText(declaration), initializerText(property), describe(getInitializer(declaration)));

// Number and subclass-typed fields: `number | undefined` beside `number`,
// `Identifier` beside `Node`.
function line(node: VariableDeclaration | PropertyAssignment): string {
  const value = node.line;
  return value === undefined ? "?" : String(value + 1);
}
function nameOf(node: VariableDeclaration | PropertyAssignment): string {
  return describe(node.name);
}
function rename(node: VariableDeclaration | PropertyAssignment, name: Identifier): void {
  node.name = name;
  node.line = name.text.length;
}
console.log(line(declaration), line(property), nameOf(declaration), nameOf(property));
rename(declaration, new Identifier("renamed"));
rename(property, new Identifier("p"));
console.log(line(declaration), line(property), nameOf(declaration), nameOf(property));

// The write reaches the original object: aliases and identity-keyed maps see it.
const ids = new Map<Node, number>();
const target = new ParenthesizedExpression(new Identifier("inner"));
ids.set(target, 7);
const alias: Node = target;
setExpression(alias, new Identifier("replaced"));
console.log(ids.get(target), describe(target.expression), target.depth);

// The receiver is evaluated once, before the value.
const trace: string[] = [];
let current: ReturnStatement | ExportAssignment = new ReturnStatement(undefined);
const other = new ExportAssignment(new Identifier("old"));
function receiver(): ReturnStatement | ExportAssignment {
  trace.push("receiver");
  return current;
}
function value(): Node {
  trace.push("value");
  current = other;
  return new Identifier("new");
}
const first = current;
receiver().expression = value();
console.log(trace.join(","), describe(first.expression), describe(other.expression));
console.log(describe(receiver().expression), trace.length);
