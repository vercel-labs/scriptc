import * as ts from "../ts7/adapter.js";
import { everyStmtList } from "../../ir/traverse.js";
import type { IrExpr, IrFunction, IrStmt, IrType } from "../../ir/ir.js";
import { locOf } from "../program.js";
import { npmStaticPackageOfPath } from "../npm-static.js";
import type { Lowerer } from "./lowerer.js";
import {
  exactClassOfReceiver,
  findMethodOn,
  findGenericMethodOn,
  type ClassInfo,
} from "./lower-classes.js";
import { classPrototypeData } from "./class-prototypes.js";
import { bindingNeverReassigned } from "./binding-analysis.js";
import { InternalCompilerError } from "../../errors.js";

/** A registry of existing class/function values allocates data, but does
 * not execute those bodies. Keep its initializer at its source position
 * and lower it only when a reached body observes the binding. Otherwise
 * merely collecting an unused registry would reach every constructor. */
export class DeferredModuleInitializers {
  private readonly pending = new Map<string, { loc: IrStmt["loc"]; lower: () => IrStmt[] }[]>();
  private readonly registryGlobals = new Set<string>();
  /** Every key ever deferred, pending or materialized. */
  private readonly deferredKeys = new Set<string>();
  /** The last scan of each function (scanOf). */
  private readonly scans = new Map<IrFunction, FunctionScan>();

  /** The sizes of the deferral tables (unit-journal.ts). */
  journalSizes(): number[] {
    let initializers = 0;
    for (const list of this.pending.values()) initializers += list.length;
    return [this.pending.size, initializers, this.registryGlobals.size, this.deferredKeys.size];
  }

  defer(lowerer: Lowerer, statement: ts.Statement): IrStmt | null {
    let key: string;
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.nodes.length === 1
    ) {
      const declaration = statement.declarationList.declarations.nodes[0]!;
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return null;
      const symbol = lowerer.checker.getSymbolAtLocation(declaration.name);
      const global = symbol && lowerer.globalsBySymbol.get(symbol);
      if (!global || !registryInitializer(lowerer, declaration.initializer, statement)) {
        return null;
      }
      key = global.id;
      if (
        ts.isObjectLiteralExpression(declaration.initializer) &&
        declaration.initializer.properties.nodes.every(
          (property) =>
            (ts.isPropertyAssignment(property) &&
              !ts.isComputedPropertyName(property.name) &&
              propertyName(property.name) !== "__proto__") ||
            ts.isShorthandPropertyAssignment(property),
        )
      )
        this.registryGlobals.add(key);
    } else if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(statement.expression.left)
    ) {
      const { left, right } = statement.expression;
      if (!registryInitializer(lowerer, right, statement)) {
        return null;
      }
      let owner = left.expression;
      const prototype = ts.isPropertyAccessExpression(owner) && owner.name.text === "prototype";
      if (prototype) owner = (owner as ts.PropertyAccessExpression).expression;
      const info = exactClassOfReceiver(lowerer, owner);
      if (
        info &&
        info.decl !== null &&
        ts.getSourceFileOfNode(info.decl) === ts.getSourceFileOfNode(statement) &&
        ts.tokenStartOfNode(info.decl) < ts.tokenStartOfNode(statement) &&
        !info.localClass &&
        !info.classDecorators &&
        !info.generic &&
        !info.callableBase &&
        !info.mixinInstance &&
        !info.def.runtime
      ) {
        if (!classWriteIsUnobserved(lowerer, info, statement)) return null;
        for (let current: ClassInfo | null = info; current; current = current.base) {
          if (
            current.methods.has(`set:${left.name.text}`) ||
            current.staticMethods?.has(`set:${left.name.text}`)
          )
            return null;
        }
        key = `${prototype ? "prototype" : "class"}:${info.def.name}`;
        if (prototype) classPrototypeData(lowerer, info, locOf(left), undefined, true);
      } else {
        if (!ts.isIdentifier(owner)) return null;
        const symbol = lowerer.resolveValueSymbol(owner);
        const global = symbol && lowerer.globalsBySymbol.get(symbol);
        if (
          !global ||
          !this.registryGlobals.has(global.id) ||
          !symbol ||
          !registryOwnerIsData(lowerer, symbol, statement)
        )
          return null;
        key = global.id;
      }
    } else return null;
    const block: Extract<IrStmt, { kind: "block" }> = {
      kind: "block",
      body: [],
      loc: locOf(statement),
    };
    const context = lowerer.ctx;
    const moduleIndex = [...lowerer.initNameOf.keys()].indexOf(ts.getSourceFileOfNode(statement));
    const initializers = this.pending.get(key) ?? [];
    initializers.push({
      loc: block.loc,
      lower: () => {
        const previousClass = lowerer.currentClass;
        lowerer.currentClass = null;
        lowerer.fnStack.push(context);
        try {
          return lowerer.shapes.withDeclaredOrderPriority([2, moduleIndex], () =>
            lowerer.lowerStmts([statement]),
          );
        } finally {
          lowerer.fnStack.pop();
          lowerer.currentClass = previousClass;
        }
      },
    });
    this.pending.set(key, initializers);
    return block;
  }

  /** Materializes the initializers that reached bodies observe. `filled`
   * receives each function whose body changes inside an unchanged statement
   * list. */
  process(
    lowerer: Lowerer,
    functions: readonly IrFunction[],
    filled?: (fn: IrFunction) => void,
  ): boolean {
    if (this.pending.size === 0) return false;
    // Scans keep only the reads of deferred bindings.
    for (const key of this.pending.keys()) {
      if (this.deferredKeys.has(key)) continue;
      this.deferredKeys.add(key);
      this.scans.clear();
    }
    // Class and prototype keys follow the classes IR types reach, and passes
    // change those inside statements they keep (a bag initializer gains a
    // prototype). While only bindings are pending, the scans of unchanged
    // statement lists are reused; SCRIPTC_CHECK_DEFERRED_SCANS=1 checks each
    // such pass against fresh scans.
    const bindingsOnly = ![...this.pending.keys()].some(
      (key) => key.startsWith("class:") || key.startsWith("prototype:"),
    );
    const scans = functions.map((fn) => this.scanOf(lowerer, fn, bindingsOnly));
    const demanded = this.demanded(lowerer, functions, scans);
    if (CHECK_SCANS && bindingsOnly) {
      const fresh = functions.map((fn) => scanFunction(lowerer, fn, this.deferredKeys));
      const expected = this.demanded(lowerer, functions, fresh);
      const blocks = (list: readonly FunctionScan[]): PlaceholderBlock[] =>
        list.flatMap((scan) => scan.placeholders.filter((block) => block.body.length === 0));
      const reused = blocks(scans);
      const live = blocks(fresh);
      if (
        [...demanded].join("\0") !== [...expected].join("\0") ||
        reused.length !== live.length ||
        reused.some((block, index) => block !== live[index])
      )
        throw new InternalCompilerError(
          "reused deferred initializer scans disagree with a fresh scan",
        );
    }
    if (demanded.size === 0) return false;
    // The placeholders come from the scans, which are fresh for every list a
    // transform replaced between waves. Each is kept with the functions whose
    // bodies hold it. Searching every body again for each initializer would
    // make materializing large module registries quadratic in the program size.
    const placeholders = new Map<string, { block: PlaceholderBlock; fns: IrFunction[] }[]>();
    const add = (block: PlaceholderBlock, fns: IrFunction[]): void => {
      const key = locationKey(block.loc);
      const blocks = placeholders.get(key) ?? [];
      blocks.push({ block, fns });
      placeholders.set(key, blocks);
    };
    functions.forEach((fn, index) => {
      for (const block of scans[index]!.placeholders) if (block.body.length === 0) add(block, [fn]);
    });
    for (const id of demanded) {
      const initialize = this.pending.get(id)!;
      this.pending.delete(id);
      for (const action of initialize) {
        const body = action.lower();
        const holders: IrFunction[] = [];
        for (const { block, fns } of placeholders.get(locationKey(action.loc)) ?? []) {
          if (block.body.length === 0) {
            block.body.push(...body);
            holders.push(...fns);
          }
        }
        if (holders.length === 0) continue;
        // These bodies changed inside unchanged statement lists.
        for (const fn of holders) {
          this.scans.delete(fn);
          filled?.(fn);
        }
        // An inserted body can introduce a placeholder needed by another
        // action in this pass. Unattached bodies are not part of the live IR.
        for (const nested of scanStatements(body).placeholders) add(nested, holders);
      }
    }
    return demanded.size !== 0;
  }

  /** The pending keys the scanned functions reference, in the order the
   * functions and their walks meet them. */
  private demanded(
    lowerer: Lowerer,
    functions: readonly IrFunction[],
    scans: readonly FunctionScan[],
  ): Set<string> {
    const demanded = new Set<string>();
    const classHelpers = new Map<string, string>();
    for (const info of lowerer.classes.values()) {
      if (info.staticDataHelper) classHelpers.set(info.staticDataHelper, `class:${info.def.name}`);
      if (info.def.prototypeDataHelper)
        classHelpers.set(info.def.prototypeDataHelper, `prototype:${info.def.name}`);
    }
    const byName = new Map(functions.map((fn, index) => [fn.name, index]));
    const usedHelpers: string[] = [];
    const demand = (events: readonly ScanEvent[]): void => {
      for (const event of events) {
        if (event.kind === "read") {
          if (this.pending.has(event.id)) demanded.add(event.id);
        } else if (event.kind === "call") {
          const owner = classHelpers.get(event.callee);
          if (owner) {
            if (this.pending.has(owner)) demanded.add(owner);
            usedHelpers.push(event.callee);
          }
        } else {
          for (
            let info = lowerer.classes.get(event.className);
            info;
            info = info.base ?? undefined
          ) {
            const key = `class:${info.def.name}`;
            if (this.pending.has(key)) demanded.add(key);
            const prototype = `prototype:${info.def.name}`;
            if (event.kind === "object" && this.pending.has(prototype)) demanded.add(prototype);
          }
        }
      }
    };
    functions.forEach((fn, index) => {
      // Prototype helpers are allocated eagerly while collecting metadata.
      // Their base-helper calls must not make unused classes reachable.
      if (classHelpers.has(fn.name)) return;
      demand(scans[index]!.signature);
      demand(scans[index]!.body);
    });
    const inspectedHelpers = new Set<string>();
    while (usedHelpers.length) {
      const name = usedHelpers.pop()!;
      if (inspectedHelpers.has(name)) continue;
      inspectedHelpers.add(name);
      const index = byName.get(name);
      if (index !== undefined) demand(scans[index]!.body);
    }
    return demanded;
  }

  /** What `fn` references that can demand an initializer, in the order a
   * walk of it meets them. While only bindings are pending (`reuse`), a
   * function's scan is reused while its statement list is the same array
   * with the same length and the same first and last statements: passes that
   * change a body either replace its list or add statements to it, and this
   * pass forgets the scan of a function whose placeholder it fills. */
  private scanOf(lowerer: Lowerer, fn: IrFunction, reuse: boolean): FunctionScan {
    const cached = this.scans.get(fn);
    if (
      reuse &&
      cached !== undefined &&
      cached.statements === fn.body &&
      cached.length === fn.body.length &&
      cached.first === fn.body[0] &&
      cached.last === fn.body[fn.body.length - 1]
    ) {
      return cached;
    }
    const scan = scanFunction(lowerer, fn, this.deferredKeys);
    this.scans.set(fn, scan);
    return scan;
  }
}

type PlaceholderBlock = Extract<IrStmt, { kind: "block" }>;

/** One reference a scan records: a class an IR type reaches (`object` also
 * reaches its prototype), a binding read, or a call to a class data
 * helper. */
type ScanEvent =
  | { kind: "object" | "classval"; className: string }
  | { kind: "read"; id: string }
  | { kind: "call"; callee: string };

interface FunctionScan {
  statements: IrStmt[];
  length: number;
  first: IrStmt | undefined;
  last: IrStmt | undefined;
  /** References of the parameter and return types. */
  signature: ScanEvent[];
  /** References of the body's expressions. */
  body: ScanEvent[];
  /** Empty blocks, in walk order: an initializer's position. */
  placeholders: PlaceholderBlock[];
}

/** Class data helpers (classStaticData, classPrototypeData). */
const CLASS_HELPER_PREFIXES = ["%static.data.", "%prototype.data."];

/** SCRIPTC_CHECK_DEFERRED_SCANS=1 checks each pass that reuses scans against fresh scans. */
const CHECK_SCANS = process.env["SCRIPTC_CHECK_DEFERRED_SCANS"] === "1";

function locationKey(loc: IrStmt["loc"]): string {
  return JSON.stringify([loc.file, loc.start, loc.end]);
}

/** The references of `fn` (FunctionScan). Each reference is kept at its
 * first occurrence, except calls, and only reads of `deferred` keys. */
function scanFunction(
  lowerer: Lowerer,
  fn: IrFunction,
  deferred: ReadonlySet<string>,
): FunctionScan {
  const signature: ScanEvent[] = [];
  const typeEvents = typeScanner(lowerer, signature);
  for (const param of fn.params) typeEvents(param.type);
  typeEvents(fn.returnType);
  const { body, placeholders } = scanStatements(fn.body, lowerer, deferred);
  return {
    statements: fn.body,
    length: fn.body.length,
    first: fn.body[0],
    last: fn.body[fn.body.length - 1],
    signature,
    body,
    placeholders,
  };
}

/** Records, once each, the classes the types it is given reach. */
function typeScanner(lowerer: Lowerer, events: ScanEvent[]): (type: IrType) => void {
  const seen = new Set<IrType>();
  const classes = new Set<string>();
  const visit = (type: IrType): void => {
    if (seen.has(type)) return;
    seen.add(type);
    if (type.kind === "object" || type.kind === "classval") {
      const key = `${type.kind}:${type.className}`;
      if (!classes.has(key)) {
        classes.add(key);
        events.push({ kind: type.kind, className: type.className });
      }
    } else if (type.kind === "array") visit(type.elem);
    else if (type.kind === "union") lowerer.unions.get(type.unionId)?.arms.forEach(visit);
    else if (type.kind === "record") {
      const shape = lowerer.shapes.get(type.shapeId);
      shape?.fields.forEach((field) => visit(field.type));
      if (shape?.indexValue) visit(shape.indexValue);
    } else if (type.kind === "func") {
      type.params.forEach(visit);
      visit(type.ret);
    } else if (type.kind === "promise") visit(type.inner);
  };
  return visit;
}

/** The references and placeholders of a statement list. Without a lowerer
 * it collects only placeholders. */
function scanStatements(
  statements: IrStmt[],
  lowerer?: Lowerer,
  deferred?: ReadonlySet<string>,
): { body: ScanEvent[]; placeholders: PlaceholderBlock[] } {
  const body: ScanEvent[] = [];
  const placeholders: PlaceholderBlock[] = [];
  const typeEvents = lowerer ? typeScanner(lowerer, body) : null;
  const reads = new Set<string>();
  const observe = (id: string): void => {
    if (deferred!.has(id) && !reads.has(id)) {
      reads.add(id);
      body.push({ kind: "read", id });
    }
  };
  everyStmtList(statements, {
    stmt: (statement) => {
      if (statement.kind === "block" && statement.body.length === 0) placeholders.push(statement);
      if (typeEvents !== null && statement.kind === "assign") observe(statement.localId);
      return true;
    },
    expr: (expr) => {
      if (typeEvents === null) return true;
      typeEvents(expr.type);
      if (observesBinding(expr)) observe(expr.localId);
      // Every call, as the helpers are visited from a stack in call order.
      if (
        expr.kind === "call" &&
        CLASS_HELPER_PREFIXES.some((prefix) => expr.callee.startsWith(prefix))
      )
        body.push({ kind: "call", callee: expr.callee });
      return true;
    },
  });
  return { body, placeholders };
}

/** A use that needs the binding initialized: a plain read, an update
 * (`n++`, `--n`) that reads before it writes, or an assignment, which
 * checks that the binding is initialized and releases its current value.
 * Assignment statements count the same way (scanStatements). */
function observesBinding(
  expr: IrExpr,
): expr is IrExpr & { kind: "varRef" | "incDec" | "assignExpr" } {
  return expr.kind === "varRef" || expr.kind === "incDec" || expr.kind === "assignExpr";
}

function registryInitializer(
  lowerer: Lowerer,
  expression: ts.Expression,
  statement: ts.Statement,
): boolean {
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    lowerer.stdlibGlobalMember(expression.expression, "Object") === "freeze"
  ) {
    if (
      !ts.isPropertyAccessExpression(expression.expression) ||
      lowerer.stdlibGlobalMember(expression.expression, "Object") !== "freeze" ||
      expression.arguments.nodes.length !== 1 ||
      !ts.isObjectLiteralExpression(expression.arguments.nodes[0]!)
    )
      return false;
    expression = expression.arguments.nodes[0]!;
  }
  const packageSource = npmStaticPackageOfPath(ts.getSourceFileOfNode(statement).fileName) !== null;
  const initialized = (declaration: ts.Node): boolean => {
    const source = ts.getSourceFileOfNode(declaration);
    return source === ts.getSourceFileOfNode(statement)
      ? ts.tokenStartOfNode(declaration) < ts.tokenStartOfNode(statement)
      : [...lowerer.initNameOf.keys()].indexOf(source) >= 0 &&
          [...lowerer.initNameOf.keys()].indexOf(source) <
            [...lowerer.initNameOf.keys()].indexOf(ts.getSourceFileOfNode(statement));
  };
  const callable = (callee: ts.Expression): boolean => {
    if (!ts.isIdentifier(callee)) return false;
    if (
      ["Array", "Float32Array", "Float64Array"].includes(callee.text) &&
      lowerer.isStdlibGlobal(callee, callee.text)
    )
      return true;
    const symbol = lowerer.resolveValueSymbol(callee);
    const declaration = symbol && symbol.valueDeclaration;
    if (!symbol || !declaration || !bindingNeverReassigned(lowerer, symbol, declaration))
      return false;
    if (ts.isFunctionDeclaration(declaration)) return true;
    if (ts.isClassDeclaration(declaration)) return initialized(declaration);
    return (
      ts.isVariableDeclaration(declaration) &&
      initialized(declaration) &&
      !!declaration.initializer &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer))
    );
  };
  const value = (node: ts.Expression, depth = 0): boolean => {
    // Let ordinary expression lowering report its named depth limit.
    // Registry discovery must not overflow before that check runs.
    if (depth > 200) return false;
    if (ts.isParenthesizedExpression(node)) return value(node.expression, depth + 1);
    if (
      ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
      ts.isNumericLiteral(node.operand)
    )
      return true;
    if (
      ts.isNumericLiteral(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword
    )
      return true;
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return true;
    // Opted-in npm source retains the same PURE call contract as published
    // bundlers. Arguments still need to be safe to omit: an annotation
    // never licenses dropping argument effects or a throwing property read.
    if (packageSource && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
      const trivia = ts.getSourceFileOfNode(node).text.slice(node.pos, ts.tokenStartOfNode(node));
      if (!/[@#]__PURE__/.test(trivia)) return false;
      if (!callable(node.expression)) return false;
      return (node.arguments?.nodes ?? []).every((argument) => value(argument, depth + 1));
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "prototype"
    ) {
      const info = exactClassOfReceiver(lowerer, node.expression.expression);
      return (
        !!info?.decl &&
        ts.getSourceFileOfNode(info.decl) === ts.getSourceFileOfNode(statement) &&
        ts.tokenStartOfNode(info.decl) < ts.tokenStartOfNode(statement) &&
        classWriteIsUnobserved(lowerer, info, statement) &&
        (findMethodOn(lowerer, info, node.name.text) !== null ||
          findGenericMethodOn(lowerer, info, node.name.text) !== null)
      );
    }
    if (packageSource && ts.isPropertyAccessExpression(node)) {
      const symbol = lowerer.checker.getSymbolAtLocation(node.name);
      const declaration = symbol && symbol.valueDeclaration;
      const owner = ts.isIdentifier(node.expression)
        ? lowerer.resolveValueSymbol(node.expression)
        : undefined;
      return (
        !!declaration &&
        ts.isPropertyAssignment(declaration) &&
        !ts.isComputedPropertyName(declaration.name) &&
        propertyName(declaration.name) !== "__proto__" &&
        !!owner &&
        registryOwnerIsData(lowerer, owner, statement) &&
        value(node.expression, depth + 1)
      );
    }
    if (ts.isArrayLiteralExpression(node))
      return node.elements.nodes.every(
        (element) => !ts.isSpreadElement(element) && value(element, depth + 1),
      );
    if (ts.isObjectLiteralExpression(node))
      return node.properties.nodes.every((property) => {
        if (
          ts.isMethodDeclaration(property) ||
          ts.isGetAccessorDeclaration(property) ||
          ts.isSetAccessorDeclaration(property)
        )
          return !!property.name && !ts.isComputedPropertyName(property.name);
        if (ts.isShorthandPropertyAssignment(property))
          return (
            !property.objectAssignmentInitializer &&
            ts.isIdentifier(property.name) &&
            value(property.name, depth + 1)
          );
        return (
          ts.isPropertyAssignment(property) &&
          !ts.isComputedPropertyName(property.name) &&
          (propertyName(property.name) !== "__proto__" ||
            property.initializer.kind === ts.SyntaxKind.NullKeyword) &&
          value(property.initializer, depth + 1)
        );
      });
    if (!ts.isIdentifier(node)) return false;
    if (node.text === "undefined" && lowerer.isStdlibGlobal(node, "undefined")) return true;
    if (
      ["Array", "Float32Array", "Float64Array"].includes(node.text) &&
      lowerer.isStdlibGlobal(node, node.text)
    )
      return true;
    const symbol = lowerer.resolveValueSymbol(node);
    const functionDeclaration = symbol && symbol.valueDeclaration;
    if (
      functionDeclaration &&
      ts.isFunctionDeclaration(functionDeclaration) &&
      ts.getSourceFileOfNode(functionDeclaration) === ts.getSourceFileOfNode(statement)
    )
      return true;
    // Reading an earlier initialized binding executes none of its
    // initializer. A deferred dependency is demanded by the emitted
    // varRef when this initializer becomes reachable.
    if (
      packageSource &&
      symbol &&
      functionDeclaration &&
      ts.isVariableDeclaration(functionDeclaration) &&
      functionDeclaration.initializer &&
      ts.getSourceFileOfNode(functionDeclaration) === ts.getSourceFileOfNode(statement) &&
      ts.tokenStartOfNode(functionDeclaration) < ts.tokenStartOfNode(statement)
    )
      return true;
    const info = symbol && lowerer.classBySymbol.get(symbol);
    const declaration = info?.decl;
    // Reading a class before its declaration can throw. Restrict this
    // optimization to earlier declarations in the same module; imports,
    // decorated classes and local factories keep ordinary initialization.
    return (
      !!declaration &&
      ts.getSourceFileOfNode(declaration) === ts.getSourceFileOfNode(statement) &&
      ts.tokenStartOfNode(declaration) < ts.tokenStartOfNode(statement) &&
      ts.isClassDeclaration(declaration) &&
      !info!.classDecorators &&
      !info!.generic &&
      !info!.localClass &&
      !info!.builtinError &&
      !info!.builtinEmitter &&
      !info!.builtinStream
    );
  };
  return value(expression);
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

/** A const binding alone does not make its properties pure: aliases,
 * descriptors and earlier writes can install a getter. Require an own
 * literal data property and no earlier mutation or escape of its owner. */
function registryOwnerIsData(
  lowerer: Lowerer,
  symbol: ts.Symbol,
  statement: ts.Statement,
): boolean {
  const declaration = symbol.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !bindingNeverReassigned(lowerer, symbol, declaration)
  )
    return false;
  let initializer = declaration.initializer;
  const frozen =
    ts.isCallExpression(initializer) &&
    ts.isPropertyAccessExpression(initializer.expression) &&
    lowerer.stdlibGlobalMember(initializer.expression, "Object") === "freeze" &&
    initializer.arguments.nodes.length === 1;
  if (frozen) initializer = (initializer as ts.CallExpression).arguments.nodes[0]!;
  if (
    !ts.isObjectLiteralExpression(initializer) ||
    !initializer.properties.nodes.every(
      (property) =>
        ts.isShorthandPropertyAssignment(property) ||
        (ts.isPropertyAssignment(property) &&
          !ts.isComputedPropertyName(property.name) &&
          (propertyName(property.name) !== "__proto__" ||
            property.initializer.kind === ts.SyntaxKind.NullKeyword)),
    )
  )
    return false;
  if (ts.getSourceFileOfNode(declaration) !== ts.getSourceFileOfNode(statement)) {
    const modules = [...lowerer.initNameOf.keys()];
    return (
      !!frozen &&
      modules.indexOf(ts.getSourceFileOfNode(declaration)) >= 0 &&
      modules.indexOf(ts.getSourceFileOfNode(declaration)) <
        modules.indexOf(ts.getSourceFileOfNode(statement))
    );
  }
  if (ts.tokenStartOfNode(declaration) >= ts.tokenStartOfNode(statement)) return false;
  if (frozen) return true;
  let safe = true;
  const visit = (node: ts.Node): void => {
    if (!safe || ts.tokenStartOfNode(node) >= ts.tokenStartOfNode(statement)) return;
    if (
      ts.isIdentifier(node) &&
      node !== declaration.name &&
      lowerer.resolveValueSymbol(node) === symbol
    ) {
      let access: ts.Node = node;
      while (ts.isPropertyAccessExpression(access.parent) && access.parent.expression === access)
        access = access.parent;
      const parent = access.parent;
      if (
        !parent ||
        access === node ||
        (ts.isBinaryExpression(parent) &&
          parent.left === access &&
          parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        (parent &&
          (ts.isPrefixUnaryExpression(parent) ||
            ts.isPostfixUnaryExpression(parent) ||
            ts.isDeleteExpression(parent) ||
            (ts.isCallExpression(parent) && parent.expression === access)))
      )
        safe = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.getSourceFileOfNode(statement));
  return safe;
}

/** Before a class registry write, arbitrary module effects can change its
 * static/prototype descriptors. Only adjacent declarations and pure
 * registry setup preserve the known setter-free target. */
function classWriteIsUnobserved(
  lowerer: Lowerer,
  info: ClassInfo,
  statement: ts.Statement,
): boolean {
  const source = ts.getSourceFileOfNode(statement);
  const declaration = info.decl!;
  if (
    declaration.members.nodes.some(
      (member) =>
        ts.isClassStaticBlockDeclaration(member) ||
        (ts.isPropertyDeclaration(member) &&
          member.initializer &&
          ts
            .getModifiers(member)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
          !registryInitializer(lowerer, member.initializer, declaration as ts.Statement)),
    )
  )
    return false;
  for (const earlier of source.statements.nodes) {
    if (
      ts.tokenStartOfNode(earlier) <= ts.tokenStartOfNode(declaration) ||
      ts.tokenStartOfNode(earlier) >= ts.tokenStartOfNode(statement)
    )
      continue;
    if (
      ts.isFunctionDeclaration(earlier) ||
      ts.isInterfaceDeclaration(earlier) ||
      ts.isTypeAliasDeclaration(earlier) ||
      ts.isEmptyStatement(earlier)
    )
      continue;
    if (
      ts.isVariableStatement(earlier) &&
      earlier.declarationList.declarations.nodes.every(
        (binding) =>
          !binding.initializer || registryInitializer(lowerer, binding.initializer, earlier),
      )
    )
      continue;
    if (
      ts.isExpressionStatement(earlier) &&
      ts.isBinaryExpression(earlier.expression) &&
      earlier.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(earlier.expression.left) &&
      registryInitializer(lowerer, earlier.expression.right, earlier)
    ) {
      const target = earlier.expression.left.expression;
      const owner =
        ts.isPropertyAccessExpression(target) && target.name.text === "prototype"
          ? target.expression
          : target;
      if (exactClassOfReceiver(lowerer, owner) === info) continue;
    }
    return false;
  }
  return true;
}
