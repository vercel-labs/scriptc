/* Divergence scan: compile-time-detectable places where a program that
 * compiles will behave differently natively than under Node. Each finding
 * is an SC6xxx warning — never a build failure (`scriptc coverage
 * --fail-on=divergences` opts into failing on them).
 *
 * The scan is deliberately narrow: a finding needs both the construct that
 * differs AND evidence in the program that the difference is observable
 * (an order-observing call on the type whose literal is reordered, ...).
 * Ordinary code produces no findings. Syntactic prefilters run first so the
 * checker is only consulted for candidate sites.
 *
 * Width copies (SC6001) are not found here: the lowering knows where it
 * copied, and width-copies.ts reports from the lowered program. The
 * binding scans below (bindingIdentityUse, bindingWrite, assertionViewCopy)
 * remain what the lowering asks when it decides how to lower a binding.
 */
import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { isNodeModulesPath } from "../resolve.js";
import {
  errorInterfaceToClassDivergenceDiag,
  islandValueCopyDivergenceDiag,
  islandValueUntrackedDivergenceDiag,
  keyOrderDivergenceDiag,
  localeCompareDivergenceDiag,
  promiseMemberWriteDivergenceDiag,
  unrelatedClassCastDivergenceDiag,
  type ScrDiagnostic,
} from "../../diagnostics/diagnostic.js";
import { typeEquals, type IrType } from "../../ir/ir.js";
import { isCollationCovered } from "./collation-repertoire.js";
import type { Lowerer } from "./lowerer.js";
import { keptIdentityAssertion } from "./assertion-identity.js";
import { islandCall, islandMadeValue } from "./lower-node-island.js";
import { withoutParentheses, withoutParenthesesTypeWrappers } from "../outer-expressions.js";

/** How an identity-sensitive binding is used after a copy could replace it. */
interface IdentityUse {
  kind: "write" | "compare";
  /** Source text of the use, e.g. `r.path` or `p === other`. */
  text: string;
  /** The written or compared expression. */
  node?: ts.Expression;
  /** A write: false when it lands on a member the copy shares with the
   * value instead of on the copy's own field (see bindingWrite). */
  copy?: boolean;
}

export function scanDivergences(
  lowerer: Lowerer,
  files: readonly ts.SourceFile[],
): ScrDiagnostic[] {
  const own = files.filter(
    (sf) =>
      !sf.isDeclarationFile && !sf.fileName.endsWith(".json") && !isNodeModulesPath(sf.fileName),
  );
  const out: ScrDiagnostic[] = [];
  const checker = lowerer.checker;
  // ── pass 1: syntactic collection ────────────────────────────────────
  const fnsByName = new Map<string, ts.FunctionLikeDeclaration[]>();
  const calls: ts.CallExpression[] = [];
  const literals: ts.ObjectLiteralExpression[] = [];
  const observers: ts.Expression[] = [];
  const casts: (ts.AsExpression | ts.TypeAssertion)[] = [];
  /** `const v: T = e`, collected only for a program that links Node islands. */
  const annotatedDecls: ts.VariableDeclaration[] = [];
  const islands = lowerer.nodeIslands !== null;
  /** The program's expressions, collected only for a program that declares
   * an interface extending Error: each is asked what slot receives it. */
  const handedOn: ts.Expression[] = [];
  /** The `new` expressions of such a program: each may bind a class's type
   * parameter to the interface. */
  const constructions: ts.NewExpression[] = [];
  const errorInterfaces = lowerer.declaresErrorInterface();
  const localeCompares: ts.CallExpression[] = [];
  /** binding name → member names assigned through it (`q.a = 2`). */
  const assignedMembers = new Map<string, Set<string>>();
  /** Member writes (`x.m = v`), looked at only in a program that declares a
   * type adding members to the library Promise (extendsPromise). */
  const memberWrites: ts.PropertyAccessExpression[] = [];
  let extendsPromise = false;
  const namesPromise = (type: ts.Node): boolean =>
    (ts.isTypeReferenceNode(type) &&
      ts.isIdentifier(type.typeName) &&
      type.typeName.text === "Promise") ||
    (ts.isExpressionWithTypeArguments(type) &&
      ts.isIdentifier(type.expression) &&
      type.expression.text === "Promise");

  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.body !== undefined &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.parameters.nodes.length > 0
    ) {
      const list = fnsByName.get(node.name.text) ?? [];
      list.push(node);
      fnsByName.set(node.name.text, list);
    }
    if (errorInterfaces && ts.isExpression(node)) {
      handedOn.push(node);
      if (ts.isNewExpression(node)) constructions.push(node);
    }
    if (ts.isCallExpression(node)) {
      calls.push(node);
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const member = callee.name.text;
        if (member === "localeCompare" && node.arguments.nodes.length === 1)
          localeCompares.push(node);
        const recv = callee.expression;
        if (ts.isIdentifier(recv)) {
          if (
            (recv.text === "JSON" && member === "stringify") ||
            (recv.text === "Object" &&
              (member === "keys" || member === "values" || member === "entries"))
          ) {
            if (node.arguments.nodes[0] !== undefined) observers.push(node.arguments.nodes[0]);
          } else if (
            recv.text === "console" &&
            (member === "log" ||
              member === "info" ||
              member === "warn" ||
              member === "error" ||
              member === "debug" ||
              member === "dir")
          ) {
            for (const a of node.arguments.nodes) if (!isLiteralLike(a)) observers.push(a);
          }
        }
      }
    } else if (ts.isForInStatement(node)) {
      observers.push(node.expression);
    } else if (ts.isVariableDeclaration(node)) {
      if (islands && node.type !== undefined && node.initializer !== undefined)
        annotatedDecls.push(node);
    } else if (ts.isObjectLiteralExpression(node)) {
      if (node.properties.nodes.length >= 1 && node.properties.nodes.every(isPlainProperty))
        literals.push(node);
    } else if (ts.isAsExpression(node) || ts.isTypeAssertion(node)) {
      casts.push(node);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      memberWrites.push(node.left);
      if (ts.isIdentifier(node.left.expression)) {
        const names = assignedMembers.get(node.left.expression.text) ?? new Set<string>();
        names.add(node.left.name.text);
        assignedMembers.set(node.left.expression.text, names);
      }
    } else if (ts.isIntersectionTypeNode(node)) {
      if (node.types.nodes.some(namesPromise)) extendsPromise = true;
    } else if (ts.isHeritageClause(node)) {
      if (node.types.nodes.some(namesPromise)) extendsPromise = true;
    }
  };
  // Iterative: absurdly deep nesting must reach the lowering's own fence.
  for (const sf of own) ts.walkPreorder(sf, visit);

  // ── key order: a reordered literal that reaches an order observer ───
  // Local flow only: the observer's argument is the literal itself, or a
  // const/let binding initialized with it in the same file. A type that
  // some other value of it is observed elsewhere is not evidence.
  if (observers.length > 0) {
    const reported = new Set<ts.Node>();
    for (const expr of observers) {
      let inner: ts.Expression = expr;
      while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner))
        inner = inner.expression;
      let lit: ts.ObjectLiteralExpression | null = null;
      let binding: string | null = null;
      if (ts.isObjectLiteralExpression(inner)) lit = inner;
      else if (ts.isIdentifier(inner)) {
        const symbol = safely(() => checker.getSymbolAtLocation(inner));
        const decl = symbol === undefined ? undefined : symbol.valueDeclaration;
        if (
          decl !== undefined &&
          ts.isVariableDeclaration(decl) &&
          decl.initializer !== undefined &&
          ts.isObjectLiteralExpression(decl.initializer) &&
          ts.getSourceFileOfNode(decl) === ts.getSourceFileOfNode(inner)
        ) {
          lit = decl.initializer;
          binding = inner.text;
        }
      }
      if (lit === null || reported.has(lit) || !literals.includes(lit)) continue;
      const contextual = safely(() => checker.getContextualType(lit!));
      if (contextual === undefined) continue;
      // A literal typed by an interface that extends Error is the object it
      // is, not a record (class-protocols.ts, markErrorInterfaces): its keys
      // enumerate as written.
      if (errorInterfaces && lowerer.errorInterface(contextual)) continue;
      if (namedObjectDeclaration(checker, contextual) === null) continue;
      const declared = safely(() =>
        checker.getPropertiesOfType(contextual).map((p) => ts.symbolName(p)),
      );
      if (declared === undefined) continue;
      const written = lit.properties.nodes.map((p) => propertyNameText(p)!);
      const assigned =
        binding === null ? new Set<string>() : (assignedMembers.get(binding) ?? new Set<string>());
      const finding = keyOrderFinding(lowerer, contextual, declared, written, assigned);
      if (finding === null) continue;
      reported.add(lit);
      out.push(
        keyOrderDivergenceDiag(
          checker.typeToString(contextual),
          finding.node,
          finding.native,
          finding.detail,
          locOf(lit),
        ),
      );
    }
  }

  // ── a member the program added to the library Promise, written ────────
  // `tracked.status = "pending"` where `tracked: Promise<T> & { status?: … }`
  // (or an interface that extends Promise): the receiver's type has the
  // library's `then`, and the written member is one the program declared.
  if (extendsPromise) {
    const declaredByLibrary = (symbol: ts.Symbol | undefined): boolean =>
      symbol !== undefined &&
      symbol.declarations.length > 0 &&
      symbol.declarations.every((d) => lowerer.isStdlibFile(ts.getSourceFileOfNode(d)));
    for (const write of memberWrites) {
      if (!ts.isIdentifier(write.name)) continue;
      const type = safely(() =>
        checker.getNonNullableType(checker.getTypeAtLocation(write.expression)),
      );
      if (type === undefined || type.isUnionType()) continue;
      const then = safely(() => checker.getPropertyOfType(type, "then"));
      const settled = safely(() => checker.getPropertyOfType(type, "finally"));
      if (!declaredByLibrary(then) || !declaredByLibrary(settled)) continue;
      const member = safely(() => checker.getPropertyOfType(type, write.name.text));
      if (member === undefined || declaredByLibrary(member)) continue;
      out.push(
        promiseMemberWriteDivergenceDiag(write.name.text, checker.typeToString(type), locOf(write)),
      );
    }
  }

  // ── one-argument localeCompare over text outside the collation table ─
  for (const call of localeCompares) {
    const access = call.expression as ts.PropertyAccessExpression;
    for (const operand of [access.expression, call.arguments.nodes[0]!]) {
      const text = stringLiteralText(operand);
      if (text !== null && !isCollationCovered(text)) {
        out.push(localeCompareDivergenceDiag(text, locOf(operand)));
        break;
      }
    }
  }

  // ── downcasts a call provably feeds a sibling class ────────────────
  // `function read(n: Base) { (n as A).x }` called with a `B` (B extends
  // Base, unrelated to A): Node reads the member structurally, natively
  // the checked class cast throws a TypeError.
  const downcasts = new Map<
    ts.Node,
    { index: number; target: ts.ClassLikeDeclaration; cast: ts.Node; member: string }[]
  >();
  for (const cast of casts) {
    let inner: ts.Expression = cast.expression;
    while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
    if (!ts.isIdentifier(inner)) continue;
    let fn: ts.Node | undefined = cast.parent;
    while (fn !== undefined && !ts.isFunctionLike(fn)) fn = fn.parent;
    if (fn === undefined || !ts.isFunctionLike(fn)) continue;
    const index = fn.parameters.nodes.findIndex(
      (p) => ts.isIdentifier(p.name) && p.name.text === inner.text,
    );
    if (index < 0) continue;
    const target = safely(() => classDeclarationOfTypeNode(lowerer, cast.type));
    if (target === undefined || target === null) continue;
    // A function that tests the parameter with instanceof guards its casts.
    if (fn.body !== undefined && testsInstanceof(fn.body, inner.text)) continue;
    // The member read through the cast: `(p as A).member`.
    let use: ts.Node = cast;
    while (use.parent !== undefined && ts.isParenthesizedExpression(use.parent)) use = use.parent;
    const access = use.parent;
    if (access === undefined || !ts.isPropertyAccessExpression(access) || access.expression !== use)
      continue;
    const list = downcasts.get(fn) ?? [];
    list.push({ index, target, cast, member: access.name.text });
    downcasts.set(fn, list);
  }
  if (downcasts.size > 0) {
    for (const call of calls) {
      const name = calleeName(call);
      if (name === null || !fnsByName.has(name)) continue;
      const signature = safely(() => checker.getResolvedSignature(call));
      const decl = signature === undefined ? undefined : safely(() => signature.declaration);
      const sites = decl === undefined ? undefined : downcasts.get(decl);
      if (sites === undefined) continue;
      for (const site of sites) {
        const arg = call.arguments.nodes[site.index];
        if (arg === undefined) continue;
        const argType = safely(() => checker.getTypeAtLocation(arg));
        const source = argType === undefined ? null : classDeclarationOfType(checker, argType);
        if (source === null || source === site.target) continue;
        if (
          classExtends(lowerer, source, site.target) ||
          classExtends(lowerer, site.target, source)
        )
          continue;
        // Node's structural read succeeds only when the instance has the
        // member; a missing method fails under Node too.
        if (argType === undefined || checker.getPropertyOfType(argType, site.member) === undefined)
          continue;
        out.push(
          unrelatedClassCastDivergenceDiag(className(source), className(site.target), locOf(arg)),
        );
      }
    }
  }

  // ── an interface that extends Error, handed to an Error class ───────
  // A value of such an interface is an error object or a plain object that
  // has the members (`const fake: Failure = { name, message }`). Where it
  // meets a slot typed by an Error class the checked conversion to the
  // class throws a TypeError for the plain object, while Node reads its
  // members. The slot is whatever gives the expression its contextual type
  // (an argument, an initializer, an assigned or returned value, a member
  // of a literal, an assertion), so no list of constructions is kept; the
  // pair is also found inside the two types: an argument of one generic
  // type (`Promise<Failure>` held as `Promise<Error>`), a member or the
  // result of a type the program declares.
  if (errorInterfaces) {
    const arms = (type: ts.Type): readonly ts.Type[] =>
      (type.flags & ts.TypeFlags.Union) !== 0 ? ts.constituentTypes(type) : [type];
    const errorClass = (type: ts.Type): boolean => {
      if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) return false;
      const mapped = safely(() => lowerer.mapTypeOf(type));
      return mapped?.kind === "object" && lowerer.isErrorRootedClass(mapped.className);
    };
    /** The type parameters a call binds to such an interface, each with
     * the interface (`through(failure)` into a parameter `e: T` where
     * `T extends Error`): inside the function a value of the parameter's
     * type is one of the interface's and is judged as one. The type
     * parameter is followed from one generic function into the next, into
     * a class through `new` (a constructor parameter, or the type arguments
     * of the instance made), and where the parameter's type holds it inside
     * a union or as a type argument (`list: T[]` given `Failure[]`). */
    const bound = new Map<ts.Type, ts.Type>();
    const interfaceOf = (arm: ts.Type): ts.Type | undefined =>
      lowerer.errorInterface(arm) ? arm : bound.get(arm);
    /** Binds each type parameter in `declared` to the interface `given`
     * has at the same place. */
    const bind = (declared: ts.Type, given: ts.Type, depth: number): void => {
      for (const slot of arms(declared)) {
        if ((slot.flags & ts.TypeFlags.TypeParameter) !== 0) {
          if (bound.has(slot)) continue;
          const found = arms(given)
            .map(interfaceOf)
            .find((held) => held !== undefined);
          if (found !== undefined) bound.set(slot, found);
        } else if (depth < 3 && slot.isTypeReference()) {
          const wanted = checker.getTypeArguments(slot);
          for (const arm of arms(given)) {
            if (!arm.isTypeReference() || arm.getTarget() !== slot.getTarget()) continue;
            for (const [index, argument] of checker.getTypeArguments(arm).entries()) {
              const inner = wanted[index];
              if (inner !== undefined) bind(inner, argument, depth + 1);
            }
          }
        }
      }
    };
    const bindArguments = (call: ts.CallExpression | ts.NewExpression): void => {
      const declaration = checker.getResolvedSignature(call)?.declaration;
      if (declaration === undefined || !ts.isFunctionLike(declaration)) return;
      for (const [index, argument] of (call.arguments?.nodes ?? []).entries()) {
        const parameter = declaration.parameters.nodes[index];
        if (parameter?.type === undefined || ts.isSpreadElement(argument)) continue;
        bind(checker.getTypeFromTypeNode(parameter.type), checker.getTypeAtLocation(argument), 0);
      }
    };
    safely(() => checker.prefetchResolvedSignatures(calls));
    for (let round = 0; round < 3; round++) {
      const before = bound.size;
      for (const call of calls) safely(() => bindArguments(call));
      for (const construction of constructions) {
        safely(() => bindArguments(construction));
        // `new Box<Failure>()`: the class's own type parameters, which the
        // generic declaration has as its type arguments.
        safely(() => {
          const made = checker.getTypeAtLocation(construction);
          const generic = made.isTypeReference() ? made.getTarget() : undefined;
          if (generic === undefined || generic === made) return;
          const given = checker.getTypeArguments(made);
          for (const [index, parameter] of checker.getTypeArguments(generic).entries()) {
            const argument = given[index];
            if (argument !== undefined) bind(parameter, argument, 0);
          }
        });
      }
      if (bound.size === before) break;
    }
    /** A structural type the program declares, whose members and result
     * are looked into. A library type holds no such interface, and a class
     * instance converts as a whole. */
    const opened = (type: ts.Type): boolean =>
      !type.isTypeReference() && namedObjectDeclaration(checker, type) !== null;
    const results = (type: ts.Type): ts.Type[] =>
      checker
        .getSignaturesOfType(type, ts.SignatureKind.Call)
        .map((signature) => checker.getReturnTypeOfSignature(signature));
    /** Whether a value of such an interface is part of `type`: the type
     * itself, an arm of it, a type argument, a member or the result. A
     * type that names itself ends at its first answer. */
    const holding = new Map<ts.Type, boolean>();
    const holds = (type: ts.Type, depth: number): boolean => {
      const known = holding.get(type);
      if (known !== undefined) return known;
      holding.set(type, false);
      const part = (inner: ts.Type): boolean => holds(inner, depth + 1);
      const answer = arms(type).some((arm) => {
        if (interfaceOf(arm) !== undefined) return true;
        if (depth >= 3) return false;
        if (arm.isTypeReference()) return checker.getTypeArguments(arm).some(part);
        return (
          opened(arm) &&
          (checker
            .getPropertiesOfType(arm)
            .some((member) => part(checker.getTypeOfSymbol(member))) ||
            results(arm).some(part))
        );
      });
      holding.set(type, answer);
      return answer;
    };
    /** The interface and the class of the conversion a `source` value takes
     * in a `target` slot, or null where it takes none. A slot that names
     * the interface itself keeps the value as it is. */
    const conversion = (
      source: ts.Type,
      target: ts.Type,
      depth: number,
    ): [ts.Type, ts.Type] | null => {
      if (source === target) return null;
      const slots = arms(target);
      for (const arm of arms(source)) {
        const from = interfaceOf(arm);
        if (from !== undefined) {
          if (slots.some((slot) => slot === arm || lowerer.errorInterface(slot))) continue;
          const to = slots.find(errorClass);
          if (to !== undefined) return [from, to];
        } else if (depth < 3) {
          for (const slot of slots) {
            const inner = arm === slot ? null : within(arm, slot, depth + 1);
            if (inner !== null) return inner;
          }
        }
      }
      return null;
    };
    /** The conversion inside two types that are not the pair themselves. */
    const within = (source: ts.Type, target: ts.Type, depth: number): [ts.Type, ts.Type] | null => {
      if (source.isTypeReference()) {
        if (!target.isTypeReference() || source.getTarget() !== target.getTarget()) return null;
        const wanted = checker.getTypeArguments(target);
        for (const [index, argument] of checker.getTypeArguments(source).entries()) {
          const slot = wanted[index];
          const inner = slot === undefined ? null : conversion(argument, slot, depth);
          if (inner !== null) return inner;
        }
        return null;
      }
      if (!opened(source)) return null;
      for (const member of checker.getPropertiesOfType(source)) {
        const slot = checker.getPropertyOfType(target, ts.symbolName(member));
        if (slot === undefined) continue;
        const inner = conversion(
          checker.getTypeOfSymbol(member),
          checker.getTypeOfSymbol(slot),
          depth,
        );
        if (inner !== null) return inner;
      }
      const wanted = results(target);
      for (const [index, result] of results(source).entries()) {
        const slot = wanted[index];
        const inner = slot === undefined ? null : conversion(result, slot, depth);
        if (inner !== null) return inner;
      }
      return null;
    };
    const logical = (node: ts.Node): node is ts.BinaryExpression =>
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken);
    /** A construction whose value is one of its operands, or is made of
     * parts that each have a slot (a literal's members, a function's
     * returns): each is judged at its own place. */
    const passesOn = (node: ts.Expression): boolean =>
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isConditionalExpression(node) ||
      ts.isArrayLiteralExpression(node) ||
      ts.isObjectLiteralExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      logical(node) ||
      (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          node.operatorToken.kind === ts.SyntaxKind.CommaToken));
    /** The types the surroundings read `value` as. Where no slot gives one,
     * an arm of a conditional and an operand of `||` or `??` become the
     * construction's own type, an element the array literal's, and a
     * returned value the result its function's returns make together. */
    const slotsOf = (value: ts.Expression): readonly ts.Type[] => {
      const contextual = checker.getContextualType(value);
      if (contextual !== undefined) return [contextual];
      const parent = value.parent;
      if (parent === undefined) return [];
      if ((ts.isConditionalExpression(parent) && parent.condition !== value) || logical(parent))
        return [checker.getTypeAtLocation(parent)];
      if (ts.isArrayLiteralExpression(parent)) {
        const literal = checker.getTypeAtLocation(parent);
        return literal.isTypeReference() ? checker.getTypeArguments(literal).slice(0, 1) : [];
      }
      if (ts.isReturnStatement(parent)) {
        let fn: ts.Node | undefined = parent.parent;
        while (fn !== undefined && !ts.isFunctionLike(fn)) fn = fn.parent;
        const signature = fn === undefined ? undefined : checker.getSignatureFromDeclaration(fn);
        if (signature === undefined) return [];
        const result = checker.getReturnTypeOfSignature(signature);
        const settled = checker.getAwaitedType(result);
        return settled === undefined || settled === result ? [result] : [result, settled];
      }
      // A spread argument no slot types: the parameters from its place on.
      if (ts.isSpreadElement(value) && ts.isCallExpression(parent)) {
        const declaration = checker.getResolvedSignature(parent)?.declaration;
        if (declaration === undefined || !ts.isFunctionLike(declaration)) return [];
        return declaration.parameters.nodes
          .slice(parent.arguments.nodes.indexOf(value))
          .flatMap((parameter) =>
            parameter.type === undefined ? [] : [checker.getTypeFromTypeNode(parameter.type)],
          );
      }
      return [];
    };
    const candidates = handedOn.filter((value) => {
      if (passesOn(value)) return false;
      const parent = value.parent;
      // A member's name is not the member's value.
      return !(
        parent !== undefined &&
        (ts.isPropertyAccessExpression(parent) ||
          (ts.isPropertyAssignment(parent) && parent.name === value))
      );
    });
    safely(() => checker.prefetchTypeQueries(candidates));
    const held = candidates.filter(
      (value) =>
        safely(() => {
          const spread = ts.isSpreadElement(value) ? value.expression : value;
          return holds(checker.getTypeAtLocation(spread), 0);
        }) === true,
    );
    safely(() => checker.prefetchContextualTypes(held));
    const warned = new Set<string>();
    const toClass = (value: ts.Expression, source: ts.Type, target: ts.Type): void => {
      const pair = conversion(source, target, 0);
      if (pair === null) return;
      const loc = locOf(value);
      const key = `${loc.file}\0${loc.start}`;
      if (warned.has(key)) return;
      warned.add(key);
      out.push(
        errorInterfaceToClassDivergenceDiag(
          checker.typeToString(pair[0]),
          checker.typeToString(pair[1]),
          loc,
        ),
      );
    };
    for (const value of held)
      safely(() => {
        // A spread hands on each element of its array or tuple.
        const sources = ts.isSpreadElement(value)
          ? checker.getTypeArguments(checker.getTypeAtLocation(value.expression))
          : [checker.getTypeAtLocation(value)];
        for (const target of slotsOf(value))
          for (const source of sources) toClass(value, source, target);
      });
    for (const cast of casts)
      safely(() =>
        toClass(
          cast.expression,
          checker.getTypeAtLocation(cast.expression),
          checker.getTypeFromTypeNode(cast.type),
        ),
      );
  }

  // ── SC6007: a value a Node island made, copied by a checked conversion ──
  // An island object or array that meets a native array or record type is
  // read member by member into a native value. The compiler sees the
  // conversion where its operand is an island read or call (or a `const` of
  // one): an assertion, a typed binding of an `any`, a typed parameter of a
  // callback passed to an island call that the callback writes through or
  // compares, and an island Map or Set declared with a native array or
  // record as a member type (the collection stays the island's; each key or
  // value read from it is converted).
  if (islands) {
    const copy = (
      typeAt: ts.Node,
      site: "assertion" | "binding" | "parameter",
      at: ts.Node,
    ): void => {
      const target =
        site === "parameter"
          ? checker.getTypeAtLocation(typeAt)
          : checker.getTypeFromTypeNode(typeAt as ts.TypeNode);
      if (!copiesIslandValue(lowerer, lowerer.mapTypeOf(target))) return;
      out.push(islandValueCopyDivergenceDiag(checker.typeToString(target), site, locOf(at)));
    };
    for (const cast of casts)
      safely(() => {
        if (islandMadeValue(lowerer, cast.expression)) copy(cast.type, "assertion", cast);
      });
    for (const decl of annotatedDecls)
      safely(() => {
        const init = withoutParentheses(decl.initializer!);
        // An assertion in the initializer is the conversion, reported above.
        if (ts.isAsExpression(init) || ts.isTypeAssertion(init)) return;
        if (islandMadeValue(lowerer, init)) copy(decl.type!, "binding", decl);
      });
    const reported = new Set<ts.Node>();
    for (const call of calls)
      safely(() => {
        if (!islandCall(lowerer, call)) return;
        const declared = checker.getTypeAtLocation(call);
        const made = checker.getAwaitedType(declared) ?? declared;
        const collection = lowerer.mapTypeOf(made);
        if (
          collection !== null &&
          ((collection.kind === "map" &&
            (copiesIslandValue(lowerer, collection.key) ||
              copiesIslandValue(lowerer, collection.value))) ||
            (collection.kind === "set" && copiesIslandValue(lowerer, collection.elem)))
        )
          out.push(
            islandValueCopyDivergenceDiag(checker.typeToString(made), "members", locOf(call)),
          );
        for (const arg of call.arguments.nodes) {
          const fn = callbackDeclaration(lowerer, arg);
          if (fn === null) continue;
          for (const param of fn.parameters.nodes) {
            if (!ts.isIdentifier(param.name) || reported.has(param)) continue;
            if (!parameterIdentityUse(fn, param.name.text)) continue;
            reported.add(param);
            copy(param, "parameter", param);
          }
        }
      });
    // An untyped island value stored where its origin is no longer followed
    // (class-protocols.ts, noteIslandEscapes): the conversion applied to it
    // after it is read back copies the island's object, at a site the scan
    // above cannot see as one.
    const ownFiles = new Set(own);
    for (const stored of lowerer.islandEscapeSites())
      if (ownFiles.has(ts.getSourceFileOfNode(stored)))
        out.push(islandValueUntrackedDivergenceDiag(locOf(stored)));
  }

  return out;
}

/** Whether the checked conversion of an island object to `target` builds a
 * native value from its members: an array, a tuple, a record with a typed
 * member, or a union with such an arm. A target that stays checked-dynamic
 * keeps the island's object. */
function copiesIslandValue(lowerer: Lowerer, target: IrType | null): boolean {
  if (target === null) return false;
  if (target.kind === "array") return true;
  if (target.kind === "record") return !keepsIdentityView(lowerer, target);
  if (target.kind !== "union") return false;
  const def = lowerer.unions.get(target.unionId);
  return def !== undefined && def.arms.some((arm) => copiesIslandValue(lowerer, arm));
}

/** The program function an argument passes: a function expression, or a
 * name that resolves to a function declaration or, through `const`
 * bindings, to a function expression. */
function callbackDeclaration(
  lowerer: Lowerer,
  arg: ts.Expression,
  depth = 0,
): ts.FunctionLikeDeclaration | null {
  const e = withoutParenthesesTypeWrappers(arg);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
  if (!ts.isIdentifier(e) || depth >= 4) return null;
  const d = (lowerer.resolveValueSymbol(e) ?? lowerer.checker.getSymbolAtLocation(e))
    ?.valueDeclaration;
  if (d === undefined) return null;
  if (ts.isFunctionDeclaration(d)) return d.body === undefined ? null : d;
  if (
    !ts.isVariableDeclaration(d) ||
    d.initializer === undefined ||
    (ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) === 0
  )
    return null;
  return callbackDeclaration(lowerer, d.initializer, depth + 1);
}

/** Whether the binding `decl` declares is used in a way a field copy would
 * change: something writes through it, or compares it with `===`/`!==`. Only
 * such a binding needs the value's own storage; a read-only view is equal
 * either way and keeps the copy the width-copy report names. A `let` or `var`
 * binding is left alone: it can be reassigned, so its declared layout stands. */
export function bindingIdentityUse(
  decl: ts.VariableDeclaration,
  checker?: ts.TypeChecker,
): boolean {
  if (!ts.isIdentifier(decl.name)) return false;
  const flags = ts.getCombinedNodeFlags(decl);
  if ((flags & ts.NodeFlags.BlockScoped) === 0 || (flags & ts.NodeFlags.Let) !== 0) return false;
  const scope = enclosingScope(decl);
  if (scope === undefined) return false;
  return identityUse(scope, decl.name.text, decl.end, symbolMatcher(decl, checker)) !== null;
}

/** Whether the body of `fn` writes through its parameter `name` or compares
 * it by identity: the uses the width-copy report names for an argument. A
 * call that passes an existing record keeps that record's layout for such a
 * parameter instead of copying it (structural-instances.ts). */
export function parameterIdentityUse(fn: ts.FunctionLikeDeclaration, name: string): boolean {
  return fn.body !== undefined && identityUse(fn.body, name) !== null;
}

/** Matches references that resolve to the binding `decl` declares, so a
 * shadowing declaration of the same name elsewhere is not mistaken for a
 * use of the binding. Undefined when the checker is unavailable or cannot
 * resolve the declaration; the scan is name-based then. */
function symbolMatcher(
  decl: ts.VariableDeclaration,
  checker: ts.TypeChecker | undefined,
): ((id: ts.Identifier) => boolean) | undefined {
  if (checker === undefined) return undefined;
  const target = safely(() => checker.getSymbolAtLocation(decl.name));
  if (target === undefined) return undefined;
  return (id: ts.Identifier): boolean => {
    const symbol = safely(() => checker.getSymbolAtLocation(id));
    return symbol !== undefined && symbol === target;
  };
}

/** The first write through the binding `decl` declares that lands on the
 * assertion's COPY (its own field), after its own declaration, or null.
 * Writes THROUGH a member the copy shares (the same object in the value
 * and in the view) reach the original object, so they do not diverge and
 * do not count. The evidence a copied binding is observable through (the
 * same scan the width-copy warning reports from). */
export function bindingWrite(lowerer: Lowerer, decl: ts.VariableDeclaration): IdentityUse | null {
  if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
  const scope = enclosingScope(decl);
  if (scope === undefined) return null;
  const name = decl.name.text;
  const use = identityUse(scope, name, decl.end, symbolMatcher(decl, lowerer.checker), (target) =>
    writeLandsOnCopy(lowerer, name, decl.initializer!, target),
  );
  return use?.kind === "write" && use.copy === true ? use : null;
}

/** The accesses that lead from the binding `name` to `target`, outermost
 * last (`v.a.b` is `[v.a, v.a.b]`), or null when `target` is not rooted
 * in the binding. */
function accessChain(target: ts.Expression, name: string): ts.Expression[] | null {
  const chain: ts.Expression[] = [];
  let cur: ts.Expression = target;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (!ts.isPropertyAccessExpression(cur) && !ts.isElementAccessExpression(cur)) break;
    chain.push(cur);
    cur = cur.expression;
  }
  if (!ts.isIdentifier(cur) || cur.text !== name) return null;
  return chain.reverse();
}

/** The member an access names, for a property access or a string-literal
 * element access. */
function memberNameOf(node: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const arg = node.argumentExpression;
    if (arg !== undefined && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)))
      return arg.text;
  }
  return null;
}

/** Whether the write at `target` (the left side of an assignment, a
 * `delete`, or an update's operand) lands on the copy. A write to one of
 * the copy's own fields does; a nested write (`view.child.n = 5`) lands on
 * the child object, which the copy shares with the value, so it does not —
 * unless the view rebuilds that member at another type. */
function writeLandsOnCopy(
  lowerer: Lowerer,
  name: string,
  initializer: ts.Expression,
  target: ts.Expression,
): boolean {
  const chain = accessChain(target, name);
  if (chain === null || chain.length < 2) return true;
  const member = memberNameOf(chain[0]!);
  if (member === null) return true;
  return !assertionViewSharesMember(lowerer, initializer, member);
}

/** Whether the copy `const v = x as View` shares the member `member` with
 * the value: the member has the same lowered type in the value and in the
 * view, so the copied field holds the child object itself. A member the
 * view adds, drops, or reshapes is rebuilt in the copy and is not shared. */
export function assertionViewSharesMember(
  lowerer: Lowerer,
  initializer: ts.Expression,
  member: string,
): boolean {
  const cast = castView(initializer);
  if (cast === null) return false;
  if (keptIdentityAssertion(lowerer, initializer) !== undefined) return false;
  return safely(() => sharesMember(lowerer, cast, member)) ?? false;
}

function sharesMember(
  lowerer: Lowerer,
  cast: { source: ts.Expression; type: ts.TypeNode },
  member: string,
): boolean {
  const checker = lowerer.checker;
  // The value the copy was made from, as widthCopyBetween sees it: beside
  // `undefined` the record itself, whose members the copy shares.
  const source = copiedValueType(checker, checker.getTypeAtLocation(cast.source));
  const target = checker.getTypeFromTypeNode(cast.type);
  const from = checker.getPropertyOfType(source, member);
  const to = checker.getPropertyOfType(target, member);
  if (from === undefined || to === undefined) return false;
  // An optional member has no slot the copy keeps as it stands.
  const optional = ts.SymbolFlags.Optional;
  if ((from.flags & optional) !== 0 || (to.flags & optional) !== 0) return false;
  const fromType = checker.getTypeOfSymbolAtLocation(from, cast.source);
  const toType = checker.getTypeOfSymbolAtLocation(to, cast.type);
  const loweredFrom = lowerer.mapTypeOf(fromType);
  const loweredTo = lowerer.mapTypeOf(toType);
  if (loweredFrom === null || loweredTo === null) return false;
  return typeEquals(loweredFrom, loweredTo);
}

/** The copy an assertion of an EXISTING object into a record view builds
 * (`const v = x as View`), or null when the assertion keeps the value it
 * views (the view is a projection the value already presents, an unknown
 * view, a class protocol, ...). The same predicate the width-copy warning
 * reports from, so a refused program is one that warning would have
 * reported. */
export function assertionViewCopy(
  lowerer: Lowerer,
  initializer: ts.Expression,
): { source: string; target: string } | null {
  const cast = castView(initializer);
  if (cast === null) return null;
  // An assertion of the global object keeps that object (assertion-identity.ts),
  // so its binding holds the global object rather than a copy.
  if (keptIdentityAssertion(lowerer, initializer) !== undefined) return null;
  return safely(() => widthCopyBetween(lowerer, cast.source, cast.type)) ?? null;
}

/** A checker query that fails here only loses a warning. */
function safely<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

function isLiteralLike(node: ts.Expression): boolean {
  return (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node)
  );
}

function stringLiteralText(node: ts.Expression | undefined): string | null {
  if (node === undefined) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** An expression that denotes an object that already exists (and so has
 * other references a copy would not update), not a fresh value. */
function isExistingObjectExpression(node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return (
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    node.kind === ts.SyntaxKind.ThisKeyword
  );
}

function isPlainProperty(p: ts.ObjectLiteralElementLike): boolean {
  return (
    (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
    propertyNameText(p) !== null
  );
}

function propertyNameText(p: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return null;
  const name = p.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** The first write through, or identity comparison of, the binding `name`
 * inside `root` (after `from`, when given). Name-based unless `resolve`
 * is given, in which case only references that resolve to the binding
 * count: a nested function that rebinds the name is skipped, and so is a
 * shadowing declaration of the same name. A write `copyWrite` rejects (one
 * that lands on a member the copy shares) does not stop the scan: a later
 * write to the copy's own field is still found, and returned when no other
 * use turns up first. */
function identityUse(
  root: ts.Node,
  name: string,
  from = -1,
  resolve?: (id: ts.Identifier) => boolean,
  copyWrite?: (target: ts.Expression) => boolean,
): IdentityUse | null {
  let found: IdentityUse | null = null;
  let shared: IdentityUse | null = null;
  const isRef = (node: ts.Expression): boolean => {
    while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))
      node = node.expression;
    return ts.isIdentifier(node) && node.text === name && (resolve === undefined || resolve(node));
  };
  const rootOf = (node: ts.Expression): ts.Expression => {
    let cur = node;
    while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur))
      cur = cur.expression;
    return cur;
  };
  // The text appears only in warnings. A build that reported warnings is
  // not reused after a source edit, so the read is not recorded as a source
  // text dependency (ts.getTextOfNode would record it).
  const textOf = (node: ts.Node): string => {
    const text = ts.getTextOfNode(node);
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  };
  /** Records a write at `target`, or remembers it and keeps scanning when
   * it lands on a member the copy shares. */
  const write = (target: ts.Expression): "stop" | undefined => {
    if (copyWrite === undefined || copyWrite(target)) {
      found = { kind: "write", text: textOf(target), node: target, copy: true };
      return "stop";
    }
    shared ??= { kind: "write", text: textOf(target), node: target, copy: false };
    return undefined;
  };
  const visit = (node: ts.Node): "skip" | "stop" | undefined => {
    if (found !== null) return "stop";
    if (node.pos < from) return node.end > from ? undefined : "skip";
    if (
      node !== root &&
      ts.isFunctionLike(node) &&
      node.parameters.nodes.some((p) => ts.isIdentifier(p.name) && p.name.text === name)
    )
      return "skip";
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        (op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          op === ts.SyntaxKind.EqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsToken) &&
        (isRef(node.left) || isRef(node.right)) &&
        !isNullish(node.left) &&
        !isNullish(node.right)
      ) {
        found = { kind: "compare", text: textOf(node) };
        return "stop";
      }
      if (
        op >= ts.SyntaxKind.FirstAssignment &&
        op <= ts.SyntaxKind.LastAssignment &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
        isRef(rootOf(node.left))
      )
        return write(node.left);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      (ts.isPropertyAccessExpression(node.operand) || ts.isElementAccessExpression(node.operand)) &&
      isRef(rootOf(node.operand))
    )
      return write(node.operand);
    if (
      ts.isDeleteExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)) &&
      isRef(rootOf(node.expression))
    )
      return write(node.expression);
    return undefined;
  };
  ts.walkPreorder(root, visit);
  // Both bindings are only assigned from the walk's callbacks, and the
  // self-hosting frontend types `found ?? shared` here as `null | undefined`
  // and refuses to lower it; two explicit returns say the same thing.
  if (found !== null) return found;
  return shared;
}

/** `expr as T`, possibly through `as unknown`: the viewed value and `T`. */
function castView(expr: ts.Expression): { source: ts.Expression; type: ts.TypeNode } | null {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!ts.isAsExpression(expr) && !ts.isTypeAssertion(expr)) return null;
  const type = expr.type;
  let inner = expr.expression;
  for (;;) {
    while (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner))
      inner = inner.expression;
    if (
      (ts.isAsExpression(inner) || ts.isTypeAssertion(inner)) &&
      (inner.type.kind === ts.SyntaxKind.UnknownKeyword ||
        inner.type.kind === ts.SyntaxKind.AnyKeyword)
    ) {
      inner = inner.expression;
      continue;
    }
    break;
  }
  return isExistingObjectExpression(inner) ? { source: inner, type } : null;
}

function testsInstanceof(root: ts.Node, name: string): boolean {
  let found = false;
  ts.walkPreorder(root, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      found = true;
      return "stop";
    }
    return undefined;
  });
  return found;
}

function isNullish(node: ts.Expression): boolean {
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined") ||
    ts.isVoidExpression(node)
  );
}

function enclosingScope(node: ts.Node): ts.Node | undefined {
  let cur = node.parent;
  while (cur !== undefined && !ts.isBlock(cur) && !ts.isSourceFile(cur)) cur = cur.parent;
  return cur;
}

/** A width copy between the value at `source` and the declared `targetNode`
 * type: a plain record whose property set differs from the target's (the
 * target may drop properties or add optional ones), or a program class
 * instance flowing into a plain record type that does not keep class
 * identity (ClassProtocols marks the targets a class instance visibly
 * flows into; a value reaching another record type is a field copy). */
function widthCopyBetween(
  lowerer: Lowerer,
  source: ts.Expression,
  targetNode: ts.TypeNode,
): { source: string; target: string } | null {
  const checker = lowerer.checker;
  const s = copiedValueType(checker, checker.getTypeAtLocation(source));
  const t = checker.getTypeFromTypeNode(targetNode);
  if (!isPlainRecordType(checker, t)) return null;
  const classSource = isProgramClassType(checker, s);
  // A union of plain records, such as `TextBlock | ThinkingBlock` narrowed by
  // an assertion, copies the arm it selects just like a single record.
  const plainSource = isPlainRecordType(checker, s);
  const arms = !classSource && !plainSource ? recordArms(checker, s) : null;
  if (!classSource && !plainSource && arms === null) return null;
  // A class-backed protocol view keeps the original value.
  if (lowerer.classImplementedProtocol(t)) return null;
  const sourceProps = checker.getPropertiesOfType(s);
  if (!classSource) {
    // Accessor members write through to captured state, so a copy of them
    // still observes the same writes: no divergence to report.
    const accessor = ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor;
    const hasAccessor = (type: ts.Type): boolean =>
      checker.getPropertiesOfType(type).some((p) => (p.flags & accessor) !== 0);
    if (arms !== null) {
      if (arms.some(hasAccessor)) return null;
      // A view with no field of its own (`{ text: unknown }`, or the record
      // the empty and unknown-only views lower to) keeps the arm it selects:
      // there is nothing to copy into, and narrowing.ts erases the assertion
      // (or boxes the live reference), so the value keeps its identity.
      const targetIr = lowerer.mapTypeOf(t);
      if (targetIr !== null && keepsIdentityView(lowerer, targetIr)) return null;
      // Only an arm that already has the target's layout may keep it.
      if (targetIr !== null) {
        for (const arm of arms) {
          const armIr = lowerer.mapTypeOf(arm);
          if (armIr !== null && typeEquals(armIr, targetIr)) return null;
        }
      }
      return { source: checker.typeToString(s), target: checker.typeToString(t) };
    }
    if (sourceProps.some((p) => (p.flags & accessor) !== 0)) return null;
    const sourceNames = new Set(sourceProps.map((p) => ts.symbolName(p)));
    const targetNames = checker.getPropertiesOfType(t).map((p) => ts.symbolName(p));
    // The same property set normally needs no conversion. Fields whose
    // representation differs (an untyped field against a declared one, a
    // field the target widens) still copy, so the layouts decide.
    if (
      targetNames.length === sourceNames.size &&
      targetNames.every((n) => sourceNames.has(n)) &&
      !recordFieldsConvert(lowerer, s, t)
    )
      return null;
  }
  return { source: checker.typeToString(s), target: checker.typeToString(t) };
}

/** Whether storing a value of `source` in `target` rebuilds it through a
 * record conversion, even though both name the same properties. */
function recordFieldsConvert(lowerer: Lowerer, source: ts.Type, target: ts.Type): boolean {
  const from = lowerer.mapTypeOf(source);
  const to = lowerer.mapTypeOf(target);
  if (!from || !to || from.kind !== "record" || to.kind !== "record") return false;
  if (typeEquals(from, to)) return false;
  return lowerer.recordWidthPlan(from.shapeId, to.shapeId) !== null;
}

/** The type of the value a conversion of `type` copies. Beside `null` or
 * `undefined` (`r as Sub` on `Base | undefined`) it is the one member that
 * holds a value: a nullish value has nothing to copy. A value narrowed by
 * `in` (`Base & Record<"k", unknown>`) still has the layout of the one
 * program record in the intersection. Every other type is itself. */
function copiedValueType(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  const nullish = ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void;
  if (type.isUnionType()) {
    const present = ts.constituentTypes(type).filter((member) => (member.flags & nullish) === 0);
    if (present.length === 1) type = present[0]!;
  }
  if (type.isIntersectionType()) {
    const records = ts
      .constituentTypes(type)
      .filter((member) => isPlainRecordType(checker, member));
    if (records.length === 1) return records[0]!;
  }
  return type;
}

/** Whether asserting to `target` keeps the value it selects: the
 * checked-dynamic representation, or a record whose every field is unknown.
 * Such a view has nothing to copy into, and narrowing.ts erases the assertion
 * (or boxes the live reference), so the assertion is pure typing. */
function keepsIdentityView(lowerer: Lowerer, target: IrType): boolean {
  if (target.kind === "dyn") return true;
  if (target.kind !== "record") return false;
  const shape = lowerer.shapes.get(target.shapeId);
  return (
    shape !== undefined &&
    !shape.tuple &&
    // The empty record has no field to copy and erases as well.
    shape.fields.every((f) => f.type.kind === "dyn") &&
    (shape.indexValue === undefined || shape.indexValue.kind === "dyn")
  );
}

/** The members of a union whose every member is a plain record; a union with
 * any other member (class, function, primitive, ...) is not a bag of records. */
function recordArms(checker: ts.TypeChecker, type: ts.Type): ts.Type[] | null {
  if (!type.isUnionType()) return null;
  const arms = [...ts.constituentTypes(type)];
  if (arms.length === 0) return null;
  for (const arm of arms) if (!isPlainRecordType(checker, arm)) return null;
  return arms;
}

function isProgramClassType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  const symbol = type.getSymbol();
  return (
    symbol !== undefined &&
    (symbol.flags & ts.SymbolFlags.Class) !== 0 &&
    symbol.declarations.some((d) => !ts.getSourceFileOfNode(d).isDeclarationFile)
  );
}

function isPlainRecordType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  if (checker.isArrayType(type) || checker.isTupleType(type)) return false;
  if (checker.getCallSignatures(type).length > 0) return false;
  if (checker.getConstructSignatures(type).length > 0) return false;
  if (checker.getIndexInfosOfType(type).length > 0) return false;
  const symbol = type.getSymbol();
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Class) !== 0) return false;
  // Library-declared object types (Map, Date, Promise, ...) are not records.
  const decls = symbol === undefined ? [] : symbol.declarations;
  if (decls.some((d) => ts.getSourceFileOfNode(d).isDeclarationFile)) return false;
  return true;
}

/** The interface/type-alias/literal declaration that names an object type,
 * or null for anything else (classes keep their own layout rules). */
function namedObjectDeclaration(checker: ts.TypeChecker, type: ts.Type): ts.Node | null {
  if ((type.flags & ts.TypeFlags.Object) === 0) return null;
  const alias = type.getAliasSymbol();
  const symbol = alias ?? type.getSymbol();
  if (symbol === undefined) return null;
  if ((symbol.flags & ts.SymbolFlags.Class) !== 0) return null;
  const decl = symbol.declarations[0];
  if (decl === undefined || ts.getSourceFileOfNode(decl).isDeclarationFile) return null;
  return decl;
}

function keyOrderFinding(
  lowerer: Lowerer,
  contextual: ts.Type,
  declared: readonly string[],
  written: readonly string[],
  assignedNames: ReadonlySet<string>,
): { native: string; node: string; detail: "reordered" | "added-later" } | null {
  // Values of a shape with orderVariants enumerate in the order their
  // literal wrote (key-order-witness.ts).
  const mapped = safely(() => lowerer.mapTypeOf(contextual));
  if (mapped?.kind === "record" && lowerer.shapes.get(mapped.shapeId)?.orderVariants !== undefined)
    return null;
  // A shape whose table the witness pass re-chose (key-order-witness.ts)
  // enumerates that table, not the checker's declaration order.
  const table = witnessTable(lowerer, contextual);
  const native = table ?? declared;
  const present = native.filter((name) => written.includes(name) && declared.includes(name));
  const writtenKnown = written.filter((name) => declared.includes(name));
  if (present.join("\0") !== writtenKnown.join("\0") && writtenKnown.length >= 2) {
    return { native: present.join(", "), node: writtenKnown.join(", "), detail: "reordered" };
  }
  // An optional property the literal leaves out but the program assigns
  // later: Node appends it after the literal's keys; natively it keeps its
  // declared slot ahead of them.
  const checker = lowerer.checker;
  for (let i = 0; i < declared.length; i++) {
    const name = declared[i]!;
    if (written.includes(name) || !assignedNames.has(name)) continue;
    if (!declared.slice(i + 1).some((later) => written.includes(later))) continue;
    const prop = checker.getPropertyOfType(contextual, name);
    if (prop === undefined || (prop.flags & ts.SymbolFlags.Optional) === 0) continue;
    const nodeOrder = [...writtenKnown, name];
    const nativeOrder = native.filter((d) => nodeOrder.includes(d));
    if (table !== null && nativeOrder.join("\0") === nodeOrder.join("\0")) continue;
    return { native: nativeOrder.join(", "), node: nodeOrder.join(", "), detail: "added-later" };
  }
  return null;
}

/** The re-chosen enumeration table of the record shape a contextual type
 * lowered to, or null when the witness pass kept today's table. */
function witnessTable(lowerer: Lowerer, contextual: ts.Type): readonly string[] | null {
  const mapped = safely(() => lowerer.mapTypeOf(contextual));
  if (mapped?.kind !== "record" || !lowerer.keyOrder.changed.has(mapped.shapeId)) return null;
  return lowerer.shapes.get(mapped.shapeId)?.declaredOrder ?? null;
}

function classDeclarationOfTypeNode(
  lowerer: Lowerer,
  node: ts.TypeNode,
): ts.ClassLikeDeclaration | null {
  if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(node.typeName);
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Class) === 0) return null;
  const decl = symbol.declarations.find((d) => ts.isClassDeclaration(d) || ts.isClassExpression(d));
  if (decl === undefined || ts.getSourceFileOfNode(decl).isDeclarationFile) return null;
  return decl as ts.ClassLikeDeclaration;
}

function classDeclarationOfType(
  checker: ts.TypeChecker,
  type: ts.Type,
): ts.ClassLikeDeclaration | null {
  const symbol = type.getSymbol();
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Class) === 0) return null;
  const decl = symbol.declarations.find((d) => ts.isClassDeclaration(d) || ts.isClassExpression(d));
  if (decl === undefined || ts.getSourceFileOfNode(decl).isDeclarationFile) return null;
  return decl as ts.ClassLikeDeclaration;
}

/** Whether `sub` names `base` in its (transitive) extends chain. */
function classExtends(
  lowerer: Lowerer,
  sub: ts.ClassLikeDeclaration,
  base: ts.ClassLikeDeclaration,
): boolean {
  let cur: ts.ClassLikeDeclaration | null = sub;
  for (let guard = 0; cur !== null && guard < 64; guard++) {
    if (cur === base) return true;
    const heritage = cur.heritageClauses?.nodes.find(
      (h) => h.token === ts.SyntaxKind.ExtendsKeyword,
    );
    const expr = heritage?.types?.nodes[0]?.expression;
    if (expr === undefined) return false;
    const symbol = lowerer.checker.getSymbolAtLocation(expr);
    if (symbol === undefined) return false;
    const resolved =
      (symbol.flags & ts.SymbolFlags.Alias) !== 0
        ? lowerer.checker.getAliasedSymbol(symbol)
        : symbol;
    const decl = resolved.declarations.find(
      (d) => ts.isClassDeclaration(d) || ts.isClassExpression(d),
    );
    cur = decl === undefined ? null : (decl as ts.ClassLikeDeclaration);
  }
  return false;
}

function className(decl: ts.ClassLikeDeclaration): string {
  return decl.name?.text ?? "(anonymous class)";
}
