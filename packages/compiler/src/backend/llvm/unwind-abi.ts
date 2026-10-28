/* The functions that propagate exceptions by unwinding instead of the
 * pending flag (see unwindAbiFunctions). */
import type { IrExpr, IrModule, IrStmt } from "../../ir/ir.js";
import { eachStringField } from "../../ir/fields.generated.js";
import { eachNodeOfKinds, type IrNodeIndex } from "../../ir/node-index.js";
import { InternalCompilerError } from "../../errors.js";

/** The kinds of every recorded node, for eachNodeOfKinds over whole bodies. */
const EVERY_KIND: ReadonlySet<string> = new Set();
/** Virtual calls, which name the methods a vtable must reach. */
const VIRTUAL_CALL_KINDS = ["virtualCall"] as const;

/** How many calls above a `throw` functions keep the pending flag. */
const THROW_LEVELS = 3;
/** The call graph's node for calls through values. */
const ANY_FUNCTION = " any function";

/** The nodes of `edges` on a cycle (a recursion), by Tarjan's algorithm
 * without recursion of its own: a large module's call chains are deeper
 * than the host stack. */
function recursiveFunctions(edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const result = new Set<string>();
  let counter = 0;
  const enter = (name: string): { name: string; next: number } => {
    index.set(name, counter);
    low.set(name, counter++);
    stack.push(name);
    onStack.add(name);
    return { name, next: 0 };
  };
  for (const root of edges.keys()) {
    if (index.has(root)) continue;
    const work = [enter(root)];
    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const out = edges.get(top.name) ?? [];
      if (top.next < out.length) {
        const callee = out[top.next++]!;
        if (!index.has(callee)) work.push(enter(callee));
        else if (onStack.has(callee))
          low.set(top.name, Math.min(low.get(top.name)!, index.get(callee)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined)
        low.set(parent.name, Math.min(low.get(parent.name)!, low.get(top.name)!));
      if (low.get(top.name) !== index.get(top.name)) continue;
      const members: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        members.push(member);
      } while (member !== top.name);
      if (members.length > 1 || out.includes(top.name)) for (const m of members) result.add(m);
    }
  }
  return result;
}

/** The may-throw functions whose exceptions reach their callers by
 * unwinding the native stack (scr_unwind_raise) instead of returning with
 * the pending flag set. Their callers call them with `invoke`, so the call
 * needs no flag test; the landing pad runs the frame's unwind.
 *
 * A function qualifies only when every way it can be reached is a direct
 * `call` from emitted code that can lower it as an `invoke`: it is not
 * async or a generator, not a constructor, not a method a virtual call can
 * reach or one a vtable holds (an overridden method), not a closure
 * target, not the entry or a library export, not named by any node other
 * than a `call`'s callee, and not called from an async or generator body
 * (coroutine bodies keep plain calls).
 *
 * A native unwind costs about 2 µs a raise and 0.1 µs a frame, against a
 * few nanoseconds for a flag test, so the functions an exception is likely to
 * cross many of keep the flag: those with a `throw` or rethrow of their own
 * and those up to THROW_LEVELS calls above one (a handler near the throw
 * takes it without a native unwind), and the recursive ones (deep stacks
 * are recursions). */
export function unwindAbiFunctions(
  mod: IrModule,
  mayThrow: ReadonlySet<string>,
  excluded: ReadonlySet<string> = new Set(),
  /** The module's node index: the bodies' nodes are read from it, in walk order, without walking. */
  nodes?: IrNodeIndex,
): Set<string> {
  const names = new Set(mod.functions.map((fn) => fn.name));
  const blocked = new Set<string>(excluded);
  blocked.add(mod.entry);
  // The runtime calls the error property readers through the pointers the
  // module installs (emit-module.ts).
  blocked.add("%error.name.read");
  blocked.add("%error.message.read");
  for (const entry of mod.lib?.exports ?? []) blocked.add(entry.fnName);
  // Methods a virtual call can reach, and the overridden methods of class
  // hierarchies (whose vtables list them), are called through pointers; the
  // others are called directly, like functions. A virtual call reaches its listed
  // targets, or else the method in its receiver class's hierarchy; a
  // receiver that is no class of the module (an interface) may reach any
  // class's method of that name.
  const classes = new Map((mod.classes ?? []).map((cls) => [cls.name, cls]));
  const anyClass = new Set<string>();
  const virtualCalls = nodes?.scan(VIRTUAL_CALL_KINDS);
  for (const fn of mod.functions)
    // Without the index (or for a function it didn't record) every node
    // arrives, statements included: the kind test narrows, not a cast.
    eachNodeOfKinds(fn, virtualCalls, (node) => {
      if (node.kind !== "virtualCall") return true;
      if (node.targets !== undefined) for (const target of node.targets) blocked.add(target);
      else if (classes.has(node.className)) blocked.add(`%${node.className}.${node.method}`);
      else anyClass.add(node.method);
      return true;
    });
  // A hierarchy's vtables hold the methods declared by more than one of its
  // classes (an override and what it overrides).
  const rootOf = (name: string): string => {
    let cls = classes.get(name);
    while (cls?.base !== undefined && classes.has(cls.base)) cls = classes.get(cls.base);
    return cls?.name ?? name;
  };
  const declarers = new Map<string, number>();
  for (const cls of mod.classes ?? [])
    for (const m of cls.methods ?? []) {
      const key = `${rootOf(cls.name)}\0${m}`;
      declarers.set(key, (declarers.get(key) ?? 0) + 1);
    }
  for (const cls of mod.classes ?? []) {
    blocked.add(`%${cls.name}.constructor`);
    blocked.add(`%${cls.name}.construct`);
    const root = rootOf(cls.name);
    for (const m of cls.methods ?? [])
      if (anyClass.has(m) || declarers.get(`${root}\0${m}`)! > 1) blocked.add(`%${cls.name}.${m}`);
  }
  // Any function a node names other than as a call's callee may be reached
  // through a pointer.
  // Every string field counts (eachStringField), as a key walk of the node
  // would find them; a call's callee does not.
  const referenced = new Set<string>();
  const noteName = (value: string): void => {
    if (names.has(value)) referenced.add(value);
  };
  const noteCallName = (value: string, field: string): void => {
    if (field !== "callee") noteName(value);
  };
  // The call graph, for the functions near a throw and the recursive ones.
  // Calls through values (closures, class values, dynamic calls, callbacks
  // passed to the runtime) reach ANY_FUNCTION, which reaches every function
  // a value can hold.
  const throws = new Set<string>();
  const callers = new Map<string, string[]>();
  const callees = new Map<string, string[]>();
  const edge = (from: string, to: string): void => {
    let list = callers.get(to);
    if (list === undefined) callers.set(to, (list = []));
    list.push(from);
    let out = callees.get(from);
    if (out === undefined) callees.set(from, (out = []));
    out.push(to);
  };
  const methodsNamed = new Map<string, string[]>();
  for (const cls of mod.classes ?? [])
    for (const m of cls.methods ?? []) {
      let list = methodsNamed.get(m);
      if (list === undefined) methodsNamed.set(m, (list = []));
      list.push(`%${cls.name}.${m}`);
    }
  const everyNode = nodes?.scanExcept(EVERY_KIND);
  for (const fn of mod.functions) {
    const coroutine = fn.async === true || fn.generator !== undefined;
    const visit = {
      expr: (e: IrExpr) => {
        const kind = e.kind as string;
        if (kind === "throw" || kind === "rethrow") throws.add(fn.name);
        if (e.kind === "call") {
          edge(fn.name, e.callee);
          // The entry's callees (the module initializers) run once: on the
          // flag they keep landing pads out of the top-level code inlined
          // into the entry.
          if (coroutine || fn.name === mod.entry) blocked.add(e.callee);
          eachStringField(e, noteCallName);
          return true;
        }
        eachStringField(e, noteName);
        if (e.kind === "virtualCall")
          for (const target of e.targets ?? methodsNamed.get(e.method) ?? []) edge(fn.name, target);
        else if (e.kind === "new") {
          edge(fn.name, `%${e.className}.constructor`);
          edge(fn.name, `%${e.className}.construct`);
        } else if (kind === "callValue" || kind === "dynCall" || kind === "newValue")
          edge(fn.name, ANY_FUNCTION);
        else if ("args" in e) {
          const args: unknown = e.args;
          if (Array.isArray(args))
            for (const arg of args as IrExpr[])
              if (arg.type.kind === "func") edge(fn.name, ANY_FUNCTION);
        }
        return true;
      },
      stmt: (s: IrStmt) => {
        const kind = s.kind as string;
        if (kind === "throw" || kind === "rethrow") throws.add(fn.name);
        eachStringField(s, noteName);
        return true;
      },
    };
    eachNodeOfKinds(fn, everyNode, (node, statement) =>
      statement ? visit.stmt(node as IrStmt) : visit.expr(node as IrExpr),
    );
  }
  for (const name of referenced) {
    blocked.add(name);
    edge(ANY_FUNCTION, name);
  }
  // A throw starts on the pending flag, and so do the functions up to
  // THROW_LEVELS calls above it. The union narrowing helpers' throws (a
  // failed narrowing) don't count for their callers.
  for (const name of throws) blocked.add(name);
  let level = [...throws].filter((name) => !name.startsWith("%union."));
  const near = new Set(level);
  for (let i = 0; i < THROW_LEVELS; i++) {
    const next: string[] = [];
    for (const name of level)
      for (const caller of callers.get(name) ?? [])
        if (!near.has(caller)) {
          near.add(caller);
          next.push(caller);
        }
    level = next;
  }
  for (const name of near) blocked.add(name);
  for (const name of recursiveFunctions(callees)) blocked.add(name);
  const result = new Set<string>();
  for (const fn of mod.functions) {
    if (!mayThrow.has(fn.name) || blocked.has(fn.name)) continue;
    if (fn.async === true || fn.generator !== undefined) continue;
    result.add(fn.name);
  }
  if (nodes !== undefined && process.env["SCRIPTC_EMIT_FACTS_VERIFY"] === "1") {
    const walked = unwindAbiFunctions(mod, mayThrow, excluded);
    if (walked.size !== result.size || [...walked].some((name) => !result.has(name)))
      throw new InternalCompilerError(
        "unwind ABI: the functions read from the node index differ from a walk's",
      );
  }
  return result;
}

/** What an unwinding-ABI function's unwind ends with when no handler of
 * its own takes the exception. */
export const UNWIND_RAISE = "call void @scr_unwind_raise()\n  unreachable";
/** What the unwind of a landing pad ends with when no handler of the
 * function takes the exception: the unwind goes on (`resume`) with the
 * exception the landing pad stored in UNWIND_SLOT. The block builder
 * expands it (BlockBuilder.terminate). */
export const UNWIND_RESUME = "resume { ptr, i32 } <unwind slot>";
/** The function's slot for the exception its landing pads take. */
export const UNWIND_SLOT = "%unw.exc";
/** scr_unwind_raise's declaration. It is not `noreturn`: sanitized builds
 * would call the sanitizer's no-return hook before it, which fails on fiber
 * stacks; scr_unwind_raise clears the unwound frames' shadow itself. */
export const UNWIND_RAISE_DECLARATION = "declare void @scr_unwind_raise() cold";

/** The personality of functions with landing pads: the landing pads are
 * cleanups that scr_unwind_raise's forced unwind runs. */
export const UNWIND_PERSONALITY = "personality ptr @__gcc_personality_v0";

/** An unwind leaving the function: a raise, or a landing pad's `resume`. */
const UNWINDS = /call void @scr_unwind_raise\(\)|\n\s+resume /;
/** A pending-flag test: the thread's exception word, the active cell, or the runtime query. */
const PENDING_TEST = /@scr_exc_flag\b|%exc\.cell\b|@scr_exc_active\b|@scr_exc_pending\(/;

/** Functions emission found breaking the unwinding ABI's rules
 * (bridgePlainUnwindCalls), by symbol: the caller emits the module again
 * with them on the pending-flag ABI. */
export class UnwindAbiViolation extends Error {
  readonly symbols: ReadonlySet<string>;
  constructor(symbols: ReadonlySet<string>) {
    super(`unwinding ABI: ${[...symbols].slice(0, 3).join(", ")} must keep the pending flag`);
    this.symbols = symbols;
  }
}
const DEFINE_NAME = /^define [^@\n]*@([\w.$%-]+)\(/;
const PLAIN_CALL = /^(\s*)(%[\w.$-]+) = call (.*?)@([\w.$%-]+)\(|^(\s*)call (.*?)@([\w.$%-]+)\(/;
const RETURN_ATTRIBUTES =
  /\b(?:zeroext|signext|noalias|nonnull|noundef|inreg|dereferenceable(?:_or_null)?\(\d+\)|align \d+)\s+/g;

/** A call instruction's line. */
const CALL_LINE = /^\s*(?:%[\w.$-]+ = )?(?:(?:tail|musttail|notail) )?call /;
/** A call's callee (a function or a register) and the parenthesis that
 * opens its arguments. */
const CALLEE = /[@%][\w.$%-]+\(/;

/** The index of the parenthesis that closes the argument list opened at `open`. */
function argumentsEnd(line: string, open: number): number {
  let depth = 0;
  let close = open;
  for (; close < line.length; close++) {
    const c = line.charAt(close);
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) break;
  }
  return close;
}

/** A call that cannot unwind, marked so: only scr_unwind_raise and the
 * raising functions propagate an unwind (runtime code and every function
 * reached through a pointer return normally), so every other call is
 * `nounwind`, and the inliner keeps it a call where it inlines a raising
 * function at an invoke. */
function markNounwind(line: string): string {
  const call = line.indexOf("call ");
  const callee = CALLEE.exec(line.slice(call));
  if (callee === null || callee[0] === "@scr_unwind_raise(") return line;
  const close = argumentsEnd(line, call + callee.index + callee[0].length - 1);
  return close >= line.length
    ? line
    : `${line.slice(0, close + 1)} nounwind${line.slice(close + 1)}`;
}

/** The functions of `part`: its text split before each `define` line
 * (`part.split(/\n(?=define )/)`), found with indexOf. */
function splitFunctions(part: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (let at = part.indexOf("\ndefine "); at >= 0; at = part.indexOf("\ndefine ", at + 1)) {
    chunks.push(part.slice(start, at));
    start = at + 1;
  }
  chunks.push(part.slice(start));
  return chunks;
}

/** Whether `code` can be part of a symbol name (`[\w.$%-]`). */
function isNameCode(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 95 /* _ */ ||
    code === 46 /* . */ ||
    code === 36 /* $ */ ||
    code === 37 /* % */ ||
    code === 45 /* - */
  );
}

/** Calls `each` with every line of `chunk` that holds `call `, by its start
 * and end offsets, once per line and in order. Lines without `call ` match
 * neither CALL_LINE nor PLAIN_CALL. */
function eachCallLine(chunk: string, each: (start: number, end: number) => void): void {
  for (let at = chunk.indexOf("call "); at >= 0;) {
    const start = chunk.lastIndexOf("\n", at) + 1;
    let end = chunk.indexOf("\n", at);
    if (end < 0) end = chunk.length;
    each(start, end);
    at = chunk.indexOf("call ", end);
  }
}

/** The value a bridged call yields on its landing pad: the dummy a
 * pending-flag callee returns with an exception pending. */
function dummyValue(type: string): string {
  if (type === "ptr") return "null";
  if (type === "double" || type === "float") return "0.0";
  if (/^i\d+$/.test(type)) return "0";
  return "zeroinitializer";
}

/** Rewrites every remaining plain call of an unwinding-ABI function (one
 * that raises, scr_unwind_raise, or resumes an unwind) in `parts`, the module's text, into an
 * invoke whose landing pad continues after the call with the exception
 * pending and the call's dummy result: the pending-flag contract those
 * call sites were emitted for, whichever lowering emitted them. Calls of
 * these functions that emitDirectCall lowered are invokes already. */
export function bridgePlainUnwindCalls(parts: string[]): string[] {
  const raisers = new Set<string>();
  const split = parts.map(splitFunctions);
  for (const chunks of split)
    for (const chunk of chunks) {
      const m = DEFINE_NAME.exec(chunk);
      if (m !== null && UNWINDS.test(chunk)) raisers.add(m[1]!);
    }
  if (raisers.size === 0) return parts;
  // An invoke's callee must raise or never test the pending flag: one that
  // returned with the flag pending would pass the exception by its invoking
  // caller unseen. A wrapper an invoke reaches (an int32 or borrowed-ABI
  // entry forwarding to the body) propagates its callee's unwind instead
  // (`resume`), so it raises too. A raising function must be reached only by
  // calls: a pointer to it (a vtable or table entry, a runtime callback)
  // could be called without a landing pad. Functions that break either rule
  // go back to the pending-flag ABI (UnwindAbiViolation).
  const violations = new Set<string>();
  const invoked = new Set<string>();
  const testsFlag = new Set<string>();
  for (const chunks of split)
    for (const chunk of chunks) {
      const m = DEFINE_NAME.exec(chunk);
      if (m !== null && PENDING_TEST.test(chunk)) testsFlag.add(m[1]!);
      for (const c of chunk.matchAll(/ invoke [^@\n]*@([\w.$%-]+)\(/g)) invoked.add(c[1]!);
    }
  const resumers = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const chunks of split)
      for (const chunk of chunks) {
        const m = DEFINE_NAME.exec(chunk);
        const name = m?.[1];
        if (name === undefined || raisers.has(name) || !invoked.has(name)) continue;
        if (![...chunk.matchAll(/ call [^@\n]*@([\w.$%-]+)\(/g)].some((c) => raisers.has(c[1]!)))
          continue;
        if (testsFlag.has(name)) continue;
        raisers.add(name);
        resumers.add(name);
        grew = true;
      }
  }
  for (const name of invoked) if (!raisers.has(name) && testsFlag.has(name)) violations.add(name);
  // Every mention of a raising function outside its `define` line, other
  // than as the callee of a call or invoke, found with indexOf.
  for (const chunks of split)
    for (const chunk of chunks)
      for (let at = chunk.indexOf("@"); at >= 0;) {
        let end = at + 1;
        while (end < chunk.length && isNameCode(chunk.charCodeAt(end))) end++;
        const next = chunk.indexOf("@", end);
        if (end === at + 1) {
          at = next;
          continue;
        }
        const name = chunk.slice(at + 1, end);
        if (raisers.has(name)) {
          const start = chunk.lastIndexOf("\n", at) + 1;
          const line = chunk.slice(start, at);
          if (
            !line.startsWith("define ") &&
            !(/(?:call|invoke) [^@]*$/.test(line) && chunk.charAt(end) === "(")
          )
            violations.add(name);
        }
        at = next;
      }
  if (violations.size > 0) throw new UnwindAbiViolation(violations);
  let personality = false;
  let counter = 0;
  const out = split.map((chunks) =>
    chunks
      .map((chunk) => {
        if (!DEFINE_NAME.test(chunk) || !chunk.includes("call ")) return chunk;
        // A function without a plain call of a raising function only marks
        // its calls nounwind: rewrite just its call lines.
        let bridged = false;
        const marks: { start: number; end: number; line: string }[] = [];
        eachCallLine(chunk, (start, end) => {
          if (bridged) return;
          const line = chunk.slice(start, end);
          const m = PLAIN_CALL.exec(line);
          const callee = m === null ? undefined : (m[4] ?? m[7]);
          if (m !== null && callee !== undefined && raisers.has(callee)) {
            bridged = true;
            return;
          }
          if (!CALL_LINE.test(line)) return;
          const marked = markNounwind(line);
          if (marked !== line) marks.push({ start, end, line: marked });
        });
        if (!bridged) {
          if (marks.length === 0) return chunk;
          const pieces: string[] = [];
          let from = 0;
          for (const mark of marks) {
            pieces.push(chunk.slice(from, mark.start), mark.line);
            from = mark.end;
          }
          pieces.push(chunk.slice(from));
          return pieces.join("");
        }
        const lines = chunk.split("\n");
        const resume = resumers.has(DEFINE_NAME.exec(chunk)![1]!);
        const result: string[] = [];
        // The label a block's terminator now follows, for phi operands.
        const moved = new Map<string, string>();
        let block = "";
        let changed = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          const label = /^([\w.$-]+):/.exec(line);
          if (label !== null) block = label[1]!;
          const m = PLAIN_CALL.exec(line);
          const callee = m === null ? undefined : (m[4] ?? m[7]);
          if (m === null || callee === undefined || !raisers.has(callee)) {
            const marked = CALL_LINE.test(line) ? markNounwind(line) : line;
            changed ||= marked !== line;
            result.push(marked);
            continue;
          }
          // The call's text from its callee to the end of the argument list.
          const close = argumentsEnd(line, line.indexOf(`@${callee}(`) + callee.length + 1);
          const head = line.slice(line.indexOf("call ") + 5, close + 1);
          const tail = line.slice(close + 1);
          const meta = /,\s*!/.exec(tail);
          const attrs = (
            meta === null ? tail.replace(/;.*$/, "") : tail.slice(0, meta.index)
          ).trimEnd();
          const dbg = meta === null ? "" : tail.slice(meta.index).replace(/\s;.*$/, "");
          const n = counter++;
          if (block === "") {
            result.splice(1, 0, "entry.ub:");
            block = "entry.ub";
          }
          const indent = m[1] ?? m[5] ?? "  ";
          const ok = `ub.ok.${n}`;
          const pad = `ub.lp.${n}`;
          if (resume) {
            // The wrapper holds nothing to release: the unwind goes on to
            // its caller's landing pad.
            const assign = m[2] !== undefined ? `${m[2]} = ` : "";
            result.push(
              `${indent}${assign}invoke ${head}${attrs} to label %${ok} unwind label %${pad}${dbg}`,
            );
            result.push(
              `${pad}:`,
              `${indent}%ub.v.${n} = landingpad { ptr, i32 } cleanup`,
              `${indent}resume { ptr, i32 } %ub.v.${n}`,
            );
            result.push(`${ok}:`);
          } else if (m[2] !== undefined) {
            const type = (m[3] ?? "").replace(RETURN_ATTRIBUTES, "").trim();
            const normal = `ub.n.${n}`;
            result.push(
              `${indent}${m[2]}.ub = invoke ${head}${attrs} to label %${normal} unwind label %${pad}${dbg}`,
            );
            result.push(`${normal}:`, `${indent}br label %${ok}`);
            result.push(
              `${pad}:`,
              `${indent}%ub.v.${n} = landingpad { ptr, i32 } cleanup`,
              `${indent}br label %${ok}`,
            );
            result.push(
              `${ok}:`,
              `${indent}${m[2]} = phi ${type} [ ${m[2]}.ub, %${normal} ], [ ${dummyValue(type)}, %${pad} ]`,
            );
          } else {
            result.push(
              `${indent}invoke ${head}${attrs} to label %${ok} unwind label %${pad}${dbg}`,
            );
            result.push(
              `${pad}:`,
              `${indent}%ub.v.${n} = landingpad { ptr, i32 } cleanup`,
              `${indent}br label %${ok}`,
            );
            result.push(`${ok}:`);
          }
          moved.set(block, ok);
          changed = true;
        }
        if (!changed) return chunk;
        if (moved.size === 0) return result.join("\n");
        personality = true;
        const header = result[0]!;
        const brace = header.lastIndexOf(" {");
        if (!header.includes("personality") && brace >= 0) {
          // Before the function's metadata attachments (`!dbg`), if any.
          const dbg = header.slice(0, brace).search(/\s!dbg !\d+$/);
          const at = dbg >= 0 ? dbg : brace;
          result[0] = `${header.slice(0, at)} ${UNWIND_PERSONALITY}${header.slice(at)}`;
        }
        // A split block's successors now come from its last part.
        if (moved.size > 0)
          for (let i = 0; i < result.length; i++) {
            const line = result[i]!;
            if (!line.includes(" phi ")) continue;
            result[i] = line.replace(/, %([\w.$-]+) \]/g, (all, name: string) => {
              const to = moved.get(name);
              return to === undefined ? all : `, %${to} ]`;
            });
          }
        return result.join("\n");
      })
      .join("\n"),
  );
  if (personality && !out.some((part) => part.includes("@__gcc_personality_v0(...)")))
    out[0] = `declare i32 @__gcc_personality_v0(...)\n${out[0]}`;
  return out;
}
