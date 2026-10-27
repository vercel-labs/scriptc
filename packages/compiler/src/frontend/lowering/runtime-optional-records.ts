import * as ts from "../ts7/adapter.js";

/** Program queries for the record-flow proof. */
export interface RecordFlowHost {
  symbolOf(node: ts.Node): ts.Symbol | null;
  declarationOf(symbol: ts.Symbol): ts.Node | undefined;
  /** The node's checker type can be a record: an object type that is not
   * an array, a function or a class instance. Answers without building a
   * layout, so the scan leaves shape interning order alone. */
  mayBeRecord(node: ts.Node): boolean;
  /** Batches the checker type queries `mayBeRecord` makes for `nodes`. */
  prefetchTypes(nodes: readonly ts.Node[]): void;
  /** The same question for a function's result. */
  mayReturnRecord(fn: Callable): boolean;
  /** The methods sharing a dispatch slot with `method` (itself included),
   * or undefined when it shares none. */
  familyOf(method: ts.Symbol): readonly ts.Symbol[] | undefined;
  /** The shape id of the node's plain record layout (named fields, no
   * tuple and no index signature), or null for any other value. */
  recordShape(node: ts.Node): string | null;
  /** The shape id of a function's plain record result, or null. */
  returnShape(fn: Callable): string | null;
  isGlobal(node: ts.Expression, name: string): boolean;
}

/** A function declaration or a class method. */
export type Callable = ts.FunctionDeclaration | ts.MethodDeclaration;

/** Calls that read a record without keeping or converting it. */
const READING_CALLS = new Map([
  ["console", new Set(["log", "info", "warn", "error", "debug", "dir"])],
  ["JSON", new Set(["stringify"])],
  ["Object", new Set(["keys", "values", "entries", "hasOwn", "getOwnPropertyNames"])],
  ["Reflect", new Set(["has", "ownKeys"])],
  ["Array", new Set(["isArray"])],
]);

/** Method names the runtime calls without a visible call site. */
const PROTOCOL_METHODS = new Set([
  "handleEvent",
  "toJSON",
  "toString",
  "toLocaleString",
  "valueOf",
  "then",
  "next",
  "return",
  "throw",
]);

/** Global functions that read a record without keeping it. */
const READING_FUNCTIONS = new Set(["String", "structuredClone"]);

/** Record values that flow between local bindings, the parameters and the
 * returns of functions whose every call site is visible, grouped into
 * classes that must share one layout. Widening a record field to hold
 * undefined changes the layout, so a class can take the widened layout only
 * when it is closed: every value entering it is a fresh object literal or
 * comes from another member, every use of a member reads or writes its
 * fields, passes it to another member, or only inspects it, and every
 * member declares the same shape. A record that reaches any other storage
 * keeps the declared layout, since converting it there would copy the
 * object. */
export class RecordFlowClasses {
  private readonly parent: number[] = [];
  private readonly open: boolean[] = [];
  /** The declaration each slot reads its shape from: a binding or
   * parameter name, or a function for its result. */
  private readonly slotNodes: ts.Node[] = [];
  private readonly slotReturns: boolean[] = [];
  private readonly shapeChecked = new Map<number, boolean>();
  private readonly bindingSlots = new Map<ts.Symbol, number>();
  private readonly returnSlots = new Map<ts.Symbol, number>();
  /** Visible functions by symbol: plain declarations called only by name,
   * and methods whose dispatch slot only direct calls reach. */
  private readonly functions = new Map<ts.Symbol, Callable>();
  /** Members sharing each visible method's dispatch slot. */
  private readonly families = new Map<ts.Symbol, readonly ts.Symbol[]>();
  /** String keys of `x["name"]` accesses. */
  private readonly literalKeys = new Set<string>();
  /** Identifiers by name; symbols resolve only for the names of slots and
   * functions, so the scan asks the checker about few nodes. */
  private readonly names = new Map<string, ts.Identifier[]>();
  /** The identifiers of each name grouped by the symbol they resolve to,
   * built on the first reference query for that name. */
  private readonly references = new Map<string, Map<ts.Symbol, ts.Identifier[]>>();
  /** Names written as shorthand properties (`{ p }`): the checker resolves
   * those to the property, so a binding of that name stays open. */
  private readonly shorthandNames = new Set<string>();
  /** Record fields of tracked bindings that flow between slots
   * (`fill(args, state.parsed)`), by owner symbol and field name. A field
   * slot widens only with its owner, whose layout holds it. */
  private readonly fieldSlots = new Map<ts.Symbol, Map<string, number>>();
  /** The owner binding slot of each field slot. */
  private readonly fieldOwners = new Map<number, number>();
  /** Object literals entering each slot; their property values enter the
   * class's field slots. */
  private readonly literalSources: { slot: number; literal: ts.ObjectLiteralExpression }[] = [];
  /** Slots whose field values are copied out whole (a spread, a
   * destructuring, `Object.values`), so a nested record would convert. */
  private readonly copiedOut = new Set<number>();
  /** Counts merges and openings, so field joins run until stable. */
  private changes = 0;

  constructor(
    private readonly files: readonly ts.SourceFile[],
    private readonly host: RecordFlowHost,
  ) {
    this.index();
    this.collectFunctions();
    this.collectSlots();
    this.connect();
    this.connectFields();
  }

  /** The class id of a binding or parameter slot, or null when the symbol
   * is not a tracked record slot. */
  bindingClass(symbol: ts.Symbol): number | null {
    const slot = this.bindingSlots.get(symbol);
    return slot === undefined ? null : this.find(slot);
  }

  /** The binding or parameter is in a class that reaches other storage. */
  opened(symbol: ts.Symbol): boolean {
    const slot = this.bindingSlots.get(symbol);
    return slot !== undefined && this.open[this.find(slot)]!;
  }

  /** Every tracked binding and parameter with its class id. */
  bindings(): [ts.Symbol, number][] {
    const out: [ts.Symbol, number][] = [];
    for (const [symbol, slot] of this.bindingSlots) out.push([symbol, this.find(slot)]);
    return out;
  }

  /** Every tracked parameter: its symbol, function and position. */
  parameters(): { symbol: ts.Symbol; fn: ts.Symbol; index: number }[] {
    const out: { symbol: ts.Symbol; fn: ts.Symbol; index: number }[] = [];
    for (const [fn, decl] of this.functions) {
      for (let index = 0; index < decl.parameters.nodes.length; index++) {
        const symbol = this.host.symbolOf(decl.parameters.nodes[index]!.name);
        if (symbol && this.bindingSlots.has(symbol)) out.push({ symbol, fn, index });
      }
    }
    return out;
  }

  /** The class id of a visible function's record return, or null. */
  returnClass(symbol: ts.Symbol): number | null {
    const slot = this.returnSlots.get(symbol);
    return slot === undefined ? null : this.find(slot);
  }

  /** The declaration of a visible function or method, whose parameters
   * and return are tracked slots. */
  visibleFunction(symbol: ts.Symbol): Callable | undefined {
    return this.functions.get(symbol);
  }

  /** A class can take a widened layout: nothing outside it reaches its
   * members and they all declare one record shape. */
  closed(classId: number): boolean {
    const root = this.find(classId);
    if (this.open[root]) return false;
    const cached = this.shapeChecked.get(root);
    if (cached !== undefined) return cached;
    let shape: string | null | undefined;
    let uniform = true;
    for (let slot = 0; slot < this.parent.length && uniform; slot++) {
      if (this.find(slot) !== root) continue;
      const node = this.slotNodes[slot]!;
      const own = this.slotReturns[slot]
        ? this.host.returnShape(node as ts.FunctionDeclaration)
        : this.host.recordShape(node);
      // Members of different shapes convert between each other.
      if (own === null || (shape !== undefined && own !== shape)) uniform = false;
      shape = own;
    }
    this.shapeChecked.set(root, uniform);
    // A field slot takes a widened layout only with its owner's class.
    for (const [slot, owner] of this.fieldOwners) {
      if (!uniform) break;
      if (this.find(slot) === root && !this.closed(owner)) uniform = false;
    }
    this.shapeChecked.set(root, uniform);
    return uniform;
  }

  /** Every field slot: its owner's class, the field name and its class. */
  fields(): { owner: number; name: string; classId: number }[] {
    const out: { owner: number; name: string; classId: number }[] = [];
    for (const byName of this.fieldSlots.values()) {
      for (const [name, slot] of byName) {
        const owner = this.fieldOwners.get(slot)!;
        out.push({ owner: this.find(owner), name, classId: this.find(slot) });
      }
    }
    return out;
  }

  private newSlot(node: ts.Node, isReturn = false): number {
    const id = this.parent.length;
    this.parent.push(id);
    this.open.push(false);
    this.slotNodes.push(node);
    this.slotReturns.push(isReturn);
    return id;
  }

  private find(slot: number): number {
    let root = slot;
    while (this.parent[root] !== root) root = this.parent[root]!;
    while (this.parent[slot] !== root) {
      const next = this.parent[slot]!;
      this.parent[slot] = root;
      slot = next;
    }
    return root;
  }

  private union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    this.parent[rb] = ra;
    this.open[ra] = this.open[ra]! || this.open[rb]!;
    this.changes++;
  }

  private markOpen(slot: number): void {
    const root = this.find(slot);
    if (!this.open[root]) this.changes++;
    this.open[root] = true;
  }

  /** The slot of a tracked binding's record field, created on first use. */
  private fieldSlot(owner: ts.Symbol, name: string, node: ts.Node): number | undefined {
    const ownerSlot = this.bindingSlots.get(owner);
    if (ownerSlot === undefined) return undefined;
    let byName = this.fieldSlots.get(owner);
    if (!byName) {
      byName = new Map();
      this.fieldSlots.set(owner, byName);
    }
    let slot = byName.get(name);
    if (slot === undefined) {
      slot = this.newSlot(node);
      byName.set(name, slot);
      this.fieldOwners.set(slot, ownerSlot);
      this.changes++;
    }
    return slot;
  }

  /** `binding.name` where the binding is a tracked slot. */
  private fieldAccess(node: ts.Node): { owner: ts.Symbol; name: string } | null {
    if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression)) return null;
    if (!ts.isIdentifier(node.name)) return null;
    const owner = this.host.symbolOf(node.expression);
    return owner && this.bindingSlots.has(owner) ? { owner, name: node.name.text } : null;
  }

  /** Joins each field slot with the same field of every member of its
   * owner's class, gives it the values that literals and assignments store
   * in the field, and opens it with its owner, until no class changes. */
  private connectFields(): void {
    const visitedUses = new Set<string>();
    const visitedLiterals = new Set<string>();
    for (let before = -1; before !== this.changes;) {
      before = this.changes;
      // Grouped once per pass; joins made during a pass show in the next.
      const members = new Map<number, ts.Symbol[]>();
      for (const [symbol, slot] of this.bindingSlots) addTo(members, this.find(slot), symbol);
      const literals = new Map<number, number[]>();
      this.literalSources.forEach(({ slot }, i) => addTo(literals, this.find(slot), i));
      const copied = new Set([...this.copiedOut].map((slot) => this.find(slot)));
      for (const [symbol, byName] of [...this.fieldSlots]) {
        const root = this.find(this.bindingSlots.get(symbol)!);
        for (const [name, field] of [...byName]) {
          for (const member of members.get(root) ?? []) {
            const peer = this.fieldSlot(member, name, this.slotNodes[field]!)!;
            this.union(field, peer);
            const key = `${this.bindingSlots.get(member)}:${name}`;
            if (visitedUses.has(key)) continue;
            visitedUses.add(key);
            for (const reference of this.referencesOf(member)) this.fieldUse(reference, name, peer);
          }
          for (const i of literals.get(root) ?? []) {
            const key = `${i}:${name}`;
            if (visitedLiterals.has(key)) continue;
            visitedLiterals.add(key);
            for (const property of this.literalSources[i]!.literal.properties.nodes) {
              if (ts.isSpreadAssignment(property)) {
                this.markOpen(field);
                continue;
              }
              const propertyName = property.name;
              if (
                !propertyName ||
                !(ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) ||
                propertyName.text !== name
              )
                continue;
              if (ts.isPropertyAssignment(property)) this.source(property.initializer, field);
              else if (ts.isShorthandPropertyAssignment(property))
                this.source(property.name as ts.Identifier, field);
              else this.markOpen(field);
            }
          }
          if (this.open[this.find(root)] || copied.has(root)) this.markOpen(field);
        }
      }
    }
  }

  /** Checks one reference to a field slot's owner: a read of the field
   * (`owner.name`, `owner["name"]`) must be a member use, and a computed
   * key can reach the field too. */
  private fieldUse(reference: ts.Identifier, name: string, field: number): void {
    const access = reference.parent;
    if (!access || (access as { expression?: ts.Node }).expression !== reference) return;
    if (ts.isPropertyAccessExpression(access)) {
      if (access.name.text === name && !this.use(access, field)) this.markOpen(field);
      return;
    }
    if (!ts.isElementAccessExpression(access)) return;
    const key = peel(access.argumentExpression);
    if (!ts.isStringLiteral(key) && !ts.isNoSubstitutionTemplateLiteral(key)) this.markOpen(field);
    else if (key.text === name && !this.use(access, field)) this.markOpen(field);
  }

  private index(): void {
    for (const file of this.files) {
      ts.walkPreorder(file, (node) => {
        if (ts.isElementAccessExpression(node)) {
          const key = peel(node.argumentExpression);
          if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))
            this.literalKeys.add(key.text);
          return undefined;
        }
        if (!ts.isIdentifier(node)) return undefined;
        if (node.parent && ts.isShorthandPropertyAssignment(node.parent))
          this.shorthandNames.add(node.text);
        const list = this.names.get(node.text);
        if (list) list.push(node);
        else this.names.set(node.text, [node]);
        return undefined;
      });
    }
  }

  /** The identifiers that name `symbol`, its declaration included. */
  private referencesOf(symbol: ts.Symbol): readonly ts.Identifier[] {
    const name = ts.symbolName(symbol);
    let bySymbol = this.references.get(name);
    if (!bySymbol) {
      bySymbol = new Map();
      for (const node of this.names.get(name) ?? []) {
        const resolved = this.host.symbolOf(node);
        if (!resolved) continue;
        const list = bySymbol.get(resolved);
        if (list) list.push(node);
        else bySymbol.set(resolved, [node]);
      }
      this.references.set(name, bySymbol);
    }
    return bySymbol.get(symbol) ?? [];
  }

  private collectFunctions(): void {
    for (const file of this.files) {
      if (file.isDeclarationFile || isJsFile(file)) continue;
      ts.walkPreorder(file, (node) => {
        if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) return undefined;
        if (node.asteriskToken || node.typeParameters?.nodes.length) return undefined;
        const flags = ts.getCombinedModifierFlags(node);
        if (flags & (ts.ModifierFlags.Export | ts.ModifierFlags.Async | ts.ModifierFlags.Ambient))
          return undefined;
        if (node.parameters.nodes.some((p) => p.dotDotDotToken || !ts.isIdentifier(p.name)))
          return undefined;
        if (usesArguments(node.body)) return undefined;
        const symbol = this.host.symbolOf(node.name);
        if (!symbol || (symbol.declarations?.length ?? 0) !== 1) return undefined;
        const calledByName = this.referencesOf(symbol).every((reference) => {
          if (reference === node.name) return true;
          const call = reference.parent;
          return (
            !!call &&
            ts.isCallExpression(call) &&
            call.expression === reference &&
            !call.arguments.nodes.some(ts.isSpreadElement)
          );
        });
        if (calledByName) {
          this.functions.set(symbol, node);
          this.families.set(symbol, [symbol]);
        }
        return undefined;
      });
    }
    this.collectMethods();
  }

  /** Methods whose every member is a plain body and whose name no other
   * declaration, dynamic access or literal key shares: then every call that
   * can dispatch to the slot names a member directly. */
  /** The class extends, directly or through its bases, a class not
   * declared in the program's own sources. */
  private extendsForeignClass(decl: ts.ClassDeclaration): boolean {
    const seen = new Set<ts.Node>();
    let current: ts.ClassDeclaration = decl;
    for (;;) {
      if (seen.has(current)) return true;
      seen.add(current);
      const heritage = current.heritageClauses?.nodes.find(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
      );
      const base = heritage?.types?.nodes[0]?.expression;
      if (!base) return false;
      const symbol = ts.isIdentifier(base) ? this.host.symbolOf(base) : null;
      const target = symbol ? this.host.declarationOf(symbol) : undefined;
      if (!target || !ts.isClassDeclaration(target)) return true;
      const file = ts.getSourceFileOfNode(target);
      if (file.isDeclarationFile || isJsFile(file)) return true;
      current = target;
    }
  }

  private collectMethods(): void {
    const candidates = new Map<ts.Symbol, ts.MethodDeclaration>();
    for (const file of this.files) {
      if (file.isDeclarationFile || isJsFile(file)) continue;
      ts.walkPreorder(file, (node) => {
        if (!ts.isMethodDeclaration(node) || !ts.isIdentifier(node.name) || !node.body)
          return undefined;
        const owner = node.parent;
        if (!owner || !ts.isClassDeclaration(owner)) return undefined;
        if (
          ts.getCombinedModifierFlags(owner) &
          (ts.ModifierFlags.Export | ts.ModifierFlags.Ambient)
        )
          return undefined;
        // The runtime calls protocol methods and the overrides of its own
        // classes (`_read`, `handleEvent`) with no call site to see.
        if (PROTOCOL_METHODS.has(node.name.text) || this.extendsForeignClass(owner))
          return undefined;
        if (node.asteriskToken || node.typeParameters?.nodes.length) return undefined;
        if (
          ts.getCombinedModifierFlags(node) &
          (ts.ModifierFlags.Async | ts.ModifierFlags.Abstract)
        )
          return undefined;
        if (node.parameters.nodes.some((p) => p.dotDotDotToken || !ts.isIdentifier(p.name)))
          return undefined;
        if (usesArguments(node.body)) return undefined;
        const symbol = this.host.symbolOf(node.name);
        if (symbol && (symbol.declarations?.length ?? 0) === 1) candidates.set(symbol, node);
        return undefined;
      });
    }
    const decided = new Set<ts.Symbol>();
    for (const [symbol, decl] of candidates) {
      if (decided.has(symbol)) continue;
      const family = this.host.familyOf(symbol) ?? [symbol];
      for (const member of family) decided.add(member);
      if (!family.every((member) => candidates.has(member))) continue;
      const name = (decl.name as ts.Identifier).text;
      if (this.literalKeys.has(name)) continue;
      const members = new Set(family);
      const direct = (this.names.get(name) ?? []).every((id) => {
        const parent = id.parent;
        const owner = this.host.symbolOf(id);
        if (owner && members.has(owner)) {
          if (parent && ts.isMethodDeclaration(parent) && parent.name === id) return true;
          const call = parent?.parent;
          return (
            !!parent &&
            ts.isPropertyAccessExpression(parent) &&
            parent.name === id &&
            !!call &&
            ts.isCallExpression(call) &&
            call.expression === parent &&
            !call.arguments.nodes.some(ts.isSpreadElement)
          );
        }
        // Any other member, property or key of this name could reach the
        // slot through a structural or dynamic view of an instance.
        return !parent || !isMemberName(id, parent);
      });
      if (!direct) continue;
      for (const member of family) {
        this.functions.set(member, candidates.get(member)!);
        this.families.set(member, family);
      }
    }
  }

  private collectSlots(): void {
    const names: ts.Identifier[] = [];
    for (const file of this.files) {
      if (file.isDeclarationFile || isJsFile(file)) continue;
      ts.walkPreorder(file, (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) names.push(node.name);
        return undefined;
      });
    }
    // The scan runs before reachability is known, so it asks about bodies
    // lowering may skip; one batch answers them.
    this.host.prefetchTypes(names);
    for (const name of names) {
      if (!this.host.mayBeRecord(name)) continue;
      const symbol = this.host.symbolOf(name);
      if (symbol) this.bindingSlots.set(symbol, this.newSlot(name));
    }
    for (const [symbol, decl] of this.functions) {
      for (const parameter of decl.parameters.nodes) {
        if (!this.host.mayBeRecord(parameter.name)) continue;
        const bound = this.host.symbolOf(parameter.name);
        if (bound) this.bindingSlots.set(bound, this.newSlot(parameter.name));
      }
      if (this.host.mayReturnRecord(decl)) this.returnSlots.set(symbol, this.newSlot(decl, true));
    }
    // A dispatch slot has one ABI: members share each parameter's and the
    // result's layout.
    for (const [symbol, family] of this.families) {
      if (family[0] !== symbol || family.length < 2) continue;
      const decls = family.map((member) => this.functions.get(member)!);
      const first = decls[0]!;
      for (let i = 0; i < first.parameters.nodes.length; i++) {
        const head = this.slotOf(first.parameters.nodes[i]!.name);
        for (const decl of decls.slice(1)) {
          const other = decl.parameters.nodes[i]
            ? this.slotOf(decl.parameters.nodes[i]!.name)
            : undefined;
          if (head !== undefined && other !== undefined) this.union(head, other);
          else if (head !== undefined) this.markOpen(head);
          else if (other !== undefined) this.markOpen(other);
        }
      }
      const results = family.map((member) => this.returnSlots.get(member));
      for (const result of results.slice(1)) {
        if (results[0] !== undefined && result !== undefined) this.union(results[0], result);
        else if (results[0] !== undefined) this.markOpen(results[0]);
        else if (result !== undefined) this.markOpen(result);
      }
    }
  }

  private slotOf(name: ts.Node): number | undefined {
    const symbol = this.host.symbolOf(name);
    return symbol ? this.bindingSlots.get(symbol) : undefined;
  }

  /** The calls that can reach a visible function or method, with the
   * callee expression each one names. */
  private callsOf(fn: ts.Symbol): ts.CallExpression[] {
    const out: ts.CallExpression[] = [];
    for (const member of this.families.get(fn) ?? [fn]) {
      for (const reference of this.referencesOf(member)) {
        const parent = reference.parent;
        if (!parent) continue;
        const callee =
          ts.isPropertyAccessExpression(parent) && parent.name === reference ? parent : reference;
        const call = callee.parent;
        if (call && ts.isCallExpression(call) && call.expression === callee) out.push(call);
      }
    }
    return out;
  }

  private connect(): void {
    for (const [symbol, slot] of this.bindingSlots) {
      const declaration = this.host.declarationOf(symbol);
      if (declaration && ts.isVariableDeclaration(declaration)) {
        const list = declaration.parent;
        const statement = list?.parent;
        if (
          !list ||
          !ts.isVariableDeclarationList(list) ||
          !statement ||
          !ts.isVariableStatement(statement) ||
          ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export
        ) {
          this.markOpen(slot);
        } else if (declaration.initializer) {
          this.source(declaration.initializer, slot);
        }
      } else if (declaration && ts.isParameter(declaration)) {
        if (declaration.questionToken) this.markOpen(slot);
        if (declaration.initializer) this.source(declaration.initializer, slot);
        const fn = declaration.parent as Callable;
        const index = fn.parameters.nodes.indexOf(declaration);
        const fnSymbol = fn.name ? this.host.symbolOf(fn.name) : null;
        for (const call of fnSymbol ? this.callsOf(fnSymbol) : []) {
          const arg = call.arguments.nodes[index];
          if (arg) this.source(arg, slot);
          else if (!declaration.initializer) this.markOpen(slot);
        }
      } else {
        this.markOpen(slot);
      }
      if (this.shorthandNames.has(ts.symbolName(symbol))) this.markOpen(slot);
      for (const reference of this.referencesOf(symbol)) {
        if (declaration && (declaration as { name?: ts.Node }).name === reference) continue;
        if (!this.use(reference, slot)) this.markOpen(slot);
      }
    }
    for (const [symbol, slot] of this.returnSlots) {
      const decl = this.functions.get(symbol)!;
      for (const expression of returnExpressions(decl)) this.source(expression, slot);
    }
  }

  /** Joins the slot with the class a value comes from, or opens the slot
   * when the value can be an object some other storage already holds. */
  private source(node: ts.Expression, slot: number): void {
    const e = peel(node);
    if (ts.isObjectLiteralExpression(e)) {
      this.literalSources.push({ slot, literal: e });
      return;
    }
    const access = this.fieldAccess(e);
    if (access) {
      this.union(slot, this.fieldSlot(access.owner, access.name, e)!);
      return;
    }
    if (ts.isIdentifier(e)) {
      const symbol = this.host.symbolOf(e);
      const other = symbol ? this.bindingSlots.get(symbol) : undefined;
      if (other !== undefined) this.union(slot, other);
      else this.markOpen(slot);
      return;
    }
    if (
      ts.isCallExpression(e) &&
      (ts.isIdentifier(e.expression) || ts.isPropertyAccessExpression(e.expression))
    ) {
      const callee = ts.isIdentifier(e.expression) ? e.expression : e.expression.name;
      const symbol = this.host.symbolOf(callee);
      const other = symbol ? this.returnSlots.get(symbol) : undefined;
      if (other !== undefined) this.union(slot, other);
      else this.markOpen(slot);
      return;
    }
    if (ts.isConditionalExpression(e)) {
      this.source(e.whenTrue, slot);
      this.source(e.whenFalse, slot);
      return;
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        this.source(e.left, slot);
        this.source(e.right, slot);
        return;
      }
      if (op === ts.SyntaxKind.CommaToken) {
        this.source(e.right, slot);
        return;
      }
    }
    this.markOpen(slot);
  }

  /** True when this reference to a member only reads or writes its fields,
   * passes the record to another member (a flow `source` joins), or
   * inspects it without keeping or converting it. */
  private use(reference: ts.Expression, slot: number): boolean {
    let value: ts.Node = reference;
    for (;;) {
      const user = value.parent;
      if (!user) return false;
      if (
        ts.isParenthesizedExpression(user) ||
        ts.isNonNullExpression(user) ||
        ts.isAsExpression(user) ||
        ts.isSatisfiesExpression(user) ||
        ts.isTypeAssertion(user)
      ) {
        value = user;
        continue;
      }
      if (ts.isPropertyAccessExpression(user) && user.expression === value) return true;
      if (ts.isElementAccessExpression(user) && user.expression === value) return true;
      if (ts.isSpreadAssignment(user)) {
        this.copiedOut.add(slot);
        return true;
      }
      if (ts.isTemplateSpan(user) || ts.isTypeOfExpression(user)) return true;
      if (ts.isExpressionStatement(user)) return true;
      if (ts.isPrefixUnaryExpression(user) && user.operator === ts.SyntaxKind.ExclamationToken)
        return true;
      if (
        (ts.isIfStatement(user) || ts.isWhileStatement(user) || ts.isDoStatement(user)) &&
        user.expression === value
      )
        return true;
      if (ts.isForInStatement(user) && user.expression === value) return true;
      if (ts.isConditionalExpression(user)) {
        if (user.condition === value) return true;
        value = user;
        continue;
      }
      if (ts.isBinaryExpression(user)) {
        const op = user.operatorToken.kind;
        if (
          op === ts.SyntaxKind.QuestionQuestionToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.AmpersandAmpersandToken
        ) {
          // The record can become the result: follow the result's use.
          value = user;
          continue;
        }
        if (op === ts.SyntaxKind.CommaToken) {
          if (user.left === value) return true;
          value = user;
          continue;
        }
        if (
          op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          op === ts.SyntaxKind.EqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsToken
        ) {
          const other = user.left === value ? user.right : user.left;
          const e = peel(other);
          if (e.kind === ts.SyntaxKind.NullKeyword || isUndefined(e)) return true;
          // Comparing identity needs both records in one layout.
          this.source(other, slot);
          return true;
        }
        const assigns =
          op === ts.SyntaxKind.EqualsToken ||
          op === ts.SyntaxKind.QuestionQuestionEqualsToken ||
          op === ts.SyntaxKind.BarBarEqualsToken ||
          op === ts.SyntaxKind.AmpersandAmpersandEqualsToken;
        // A record assigned to a member joins it when the member's own
        // reference is visited, below.
        if (assigns && user.right === value)
          return this.isMember(user.left) || this.isFieldMember(user.left);
        if (assigns && user.left === value && value === reference) {
          this.source(user.right, slot);
          return true;
        }
        if (op === ts.SyntaxKind.InKeyword || op === ts.SyntaxKind.InstanceOfKeyword) return true;
        return false;
      }
      if (ts.isVariableDeclaration(user) && user.initializer === value) {
        if (ts.isObjectBindingPattern(user.name)) {
          this.copiedOut.add(slot);
          return true;
        }
        return this.isMember(user.name);
      }
      if (ts.isReturnStatement(user)) {
        const fn = enclosingFunction(user);
        const symbol =
          fn && (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name
            ? this.host.symbolOf(fn.name)
            : null;
        return !!symbol && this.returnSlots.has(symbol);
      }
      if (ts.isCallExpression(user) && user.expression !== value) {
        const callee = peel(user.expression);
        if (ts.isIdentifier(callee)) {
          if (READING_FUNCTIONS.has(callee.text) && this.host.isGlobal(callee, callee.text))
            return true;
          const symbol = this.host.symbolOf(callee);
          const fn = symbol ? this.functions.get(symbol) : undefined;
          if (!fn) return false;
          const parameter =
            fn.parameters.nodes[user.arguments.nodes.indexOf(value as ts.Expression)];
          return !!parameter && this.isMember(parameter.name);
        }
        if (ts.isPropertyAccessExpression(callee)) {
          const symbol = this.host.symbolOf(callee.name);
          const method = symbol ? this.functions.get(symbol) : undefined;
          if (method) {
            const parameter =
              method.parameters.nodes[user.arguments.nodes.indexOf(value as ts.Expression)];
            return !!parameter && this.isMember(parameter.name);
          }
        }
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
          const methods = READING_CALLS.get(callee.expression.text);
          const reads =
            !!methods &&
            methods.has(callee.name.text) &&
            this.host.isGlobal(callee.expression, callee.expression.text);
          if (reads && (callee.name.text === "values" || callee.name.text === "entries"))
            this.copiedOut.add(slot);
          return reads;
        }
        return false;
      }
      return false;
    }
  }

  private isMember(node: ts.Node): boolean {
    if (!ts.isIdentifier(node)) return false;
    const symbol = this.host.symbolOf(node);
    return !!symbol && this.bindingSlots.has(symbol);
  }

  /** A tracked binding's field as an assignment target: the stored record
   * joins the field slot when the field's uses are visited. */
  private isFieldMember(node: ts.Node): boolean {
    const access = this.fieldAccess(node);
    return !!access && this.fieldSlot(access.owner, access.name, node) !== undefined;
  }
}

function addTo<T>(map: Map<number, T[]>, key: number, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The return expressions of a function body, excluding nested functions. */
export function returnExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) {
      if (node.expression) out.push(node.expression);
      return;
    }
    if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))
      return;
    ts.forEachChild(node, visit);
  };
  if (fn.body !== undefined) ts.forEachChild(fn.body, visit);
  return out;
}

/** The identifier names a member: a property, method or accessor in a
 * class, interface, type or object literal, a property read, or an object
 * pattern key. */
function isMemberName(id: ts.Identifier, parent: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(parent)) return parent.name === id;
  if (ts.isBindingElement(parent))
    return (
      parent.propertyName === id ||
      (!parent.propertyName && parent.name === id && ts.isObjectBindingPattern(parent.parent))
    );
  return (
    (ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodSignatureDeclaration(parent) ||
      ts.isPropertySignatureDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isShorthandPropertyAssignment(parent)) &&
    (parent as { name?: ts.Node }).name === id
  );
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  for (let n = node.parent; n; n = n.parent)
    if (ts.isFunctionLike(n)) return n as ts.FunctionLikeDeclaration;
  return null;
}

function usesArguments(body: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === "arguments") found = true;
    else if (!ts.isFunctionDeclaration(node) && !ts.isFunctionExpression(node))
      ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

function isUndefined(node: ts.Expression): boolean {
  return ts.isIdentifier(node) && node.text === "undefined";
}

function isJsFile(file: ts.SourceFile): boolean {
  return /\.(c|m)?jsx?$/.test(file.fileName);
}

function peel(node: ts.Expression): ts.Expression {
  let e = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertion(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression;
  return e;
}
