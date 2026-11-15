/* Positions for the source frames of dev builds.
 *
 * A function's source frame is `{ previous, text }` (emit-function.ts), and
 * an Error copies the `text` of every frame on the chain when it is created.
 * Release builds store one constant per function, `    at name (file)`. A
 * build that carries debug sources stores a constant per statement instead,
 * `    at name (file:line:column)`, before the statement runs: the innermost
 * frame then names the statement that raised the error, and each caller's
 * frame the statement whose call is still running. The runtime copies the
 * text as it always did, so no runtime unit knows about positions. */
import type { IrStmt, SrcLoc } from "../../ir/ir.js";
import { everyStmtChild } from "../../ir/traverse.js";
import type { SourcePosition } from "../source-locations.js";

/** The frame line of a function that stores no positions. */
export function frameText(sourceName: string, file: string): string {
  return `    at ${sourceName} (${file})`;
}

/** The frame line of a statement at `pos`. Module-level code has no
 * function name and prints the bare position, as Node does for the body of
 * an ES module. */
export function positionedFrameText(name: string | undefined, pos: SourcePosition): string {
  const where = `${pos.file}:${pos.line}:${pos.column}`;
  return name === undefined ? `    at ${where}` : `    at ${name} (${where})`;
}

/** The frame name of a class member, from the class's JavaScript name and
 * the member's IR name (`constructor`, `m`, `get:p`, `static:m`, each with
 * an optional `%<digest>` of a generic instantiation), in V8's spelling:
 * `new C`, `C.m`, `C.get p`. */
export function memberFrameName(className: string, member: string): string {
  const cls = className === "" ? "<anonymous>" : className;
  let name = member.replace(/%[0-9a-f]+$/, "");
  if (name === "constructor") return `new ${cls}`;
  if (name.startsWith("static:")) name = name.slice("static:".length);
  const accessor = /^(get|set):(.+)$/.exec(name);
  return accessor === null ? `${cls}.${name}` : `${cls}.${accessor[1]} ${accessor[2]}`;
}

/** Statements that run nothing of their own once a statement of their body
 * has finished: the next one stores its position, or control leaves. Every
 * other statement that holds a statement (a loop's condition, update and
 * iterator step) has code left to run, so its position is stored again
 * when the child finishes. So is a container's when the child was not in
 * its body but embedded in its head: the rest of an `if` condition or a
 * `switch` test runs next. */
const CONTAINERS: ReadonlySet<IrStmt["kind"]> = new Set(["if", "switch", "tryCatch"]);

/** Statements that store nothing: a block runs no code of its own, and a
 * jump only leaves. `continue` stores its target loop's position instead
 * (continueLoop). */
const TRANSPARENT: ReadonlySet<IrStmt["kind"]> = new Set([
  "block",
  "break",
  "continue",
  "genBindBarrier",
]);

/** What `enter` hands to `leave`: the enclosing statement's state. */
export interface FramePositionRestore {
  readonly text: string | null;
  /** The enclosing statement has code of its own left once this one ends. */
  readonly resumes: boolean;
  /** The statement is a loop, which `continue` statements inside it name. */
  readonly loop: boolean;
  /** The enclosing statement is a container. */
  readonly container: boolean;
}

/** The positions one function's frame takes while its body is emitted. */
export class FramePositions {
  /** The text the frame holds while the innermost storing statement runs. */
  private text: string | null = null;
  /** Whether that statement is a container (CONTAINERS). */
  private container = false;
  private readonly loops: { labels: readonly string[] | undefined; text: string }[] = [];
  /** The statements of the bodies of the containers and blocks entered so
   * far. A statement outside this set is embedded in an expression. */
  private readonly bodies = new Set<IrStmt>();

  constructor(
    /** The frame's function name; undefined for module-level code. */
    readonly name: string | undefined,
    private readonly position: (loc: SrcLoc) => SourcePosition | null,
    /** Emits the store of a frame line into the frame's text slot. */
    private readonly store: (text: string) => void,
  ) {}

  /** The frame line for `loc`, or null where the sources do not hold it. */
  textAt(loc: SrcLoc): string | null {
    const pos = this.position(loc);
    return pos === null ? null : positionedFrameText(this.name, pos);
  }

  /** Before statement `s` is emitted. Null when `s` stores nothing, which
   * `leave` takes back unchanged. */
  enter(s: IrStmt): FramePositionRestore | null {
    if (s.kind === "block" || CONTAINERS.has(s.kind)) {
      everyStmtChild(
        s,
        () => true,
        (child) => {
          this.bodies.add(child);
          return true;
        },
      );
    }
    if (TRANSPARENT.has(s.kind)) return null;
    const text = this.textAt(s.loc);
    if (text === null) return null;
    let loop = false;
    if (s.kind === "while" || s.kind === "doWhile" || s.kind === "for" || s.kind === "forOf") {
      this.loops.push({ labels: s.labels, text });
      loop = true;
    }
    // A container resumes only after a statement embedded in its head.
    const restore = {
      text: this.text,
      resumes: this.container ? !this.bodies.has(s) : this.text !== null,
      loop,
      container: this.container,
    };
    this.store(text);
    this.text = text;
    this.container = CONTAINERS.has(s.kind);
    return restore;
  }

  /** Where a `continue` jumps, after the `finally` blocks it crosses: the
   * loop's condition, update or iterator step runs next, at the loop's
   * position. The loop is the innermost one, or the one that carries
   * `label`. */
  continueLoop(label: string | undefined): void {
    for (let i = this.loops.length - 1; i >= 0; i--) {
      const loop = this.loops[i]!;
      if (label === undefined || loop.labels?.includes(label)) {
        this.store(loop.text);
        return;
      }
    }
  }

  /** After the statement `enter` answered `restore` for was emitted; `open`
   * says whether control can fall out of it into the enclosing statement. */
  leave(restore: FramePositionRestore | null, open: boolean): void {
    if (restore === null) return;
    if (restore.loop) this.loops.pop();
    this.text = restore.text;
    this.container = restore.container;
    if (open && restore.resumes && restore.text !== null) this.store(restore.text);
  }
}

/** The frames an abort prints (Error.stackTraceLimit's default). */
const ABORT_FRAME_LIMIT = 10;

/** What the abort report calls. */
export const ABORT_FRAMES_DECLARATIONS: readonly string[] = [
  "declare ptr @scr_exc_current_cell()",
  "declare i64 @strlen(ptr)",
  "declare i64 @write(i32, ptr, i64)",
  "declare ptr @signal(i32, ptr)",
];

/** Installs the abort report; the entry function runs it once the runtime
 * is initialized. 6 is SIGABRT on every POSIX target. */
export const ABORT_FRAMES_INSTALL = "  call ptr @signal(i32 6, ptr @sc_abort_frames)";

/** A dev executable's report of where it aborted. The runtime ends the
 * process through abort() when a fact the compiled code relies on turns
 * out false (an index proven in range that is not), and it creates no
 * Error for that, so nothing captures the frames. This SIGABRT handler
 * writes the frame chain as it stands, one line per frame under the
 * runtime's message, and returns into abort(), which ends the process as
 * before. It only reads the chain and calls write(), which a signal
 * handler may. `attrs` are the emitted functions' attributes. The frame
 * chain is at byte 56 of the exception cell on 64-bit targets
 * (scr_exception.h asserts it), a frame is `{ previous, text }`. */
export function abortFramesDefinition(attrs: string): string[] {
  return [
    `@sc_abort_frames.newline = private unnamed_addr constant [1 x i8] c"\\0A"`,
    `define internal void @sc_abort_frames(i32 %signal) ${attrs} {`,
    `entry:`,
    `  %cell = call ptr @scr_exc_current_cell()`,
    `  %chain = getelementptr inbounds i8, ptr %cell, i64 56`,
    `  %first = load ptr, ptr %chain`,
    `  br label %next`,
    `next:`,
    `  %frame = phi ptr [ %first, %entry ], [ %previous, %line ]`,
    `  %count = phi i32 [ 0, %entry ], [ %counted, %line ]`,
    `  %last = icmp eq ptr %frame, null`,
    `  %full = icmp eq i32 %count, ${ABORT_FRAME_LIMIT}`,
    `  %done = or i1 %last, %full`,
    `  br i1 %done, label %out, label %line`,
    `line:`,
    `  %text.slot = getelementptr inbounds i8, ptr %frame, i64 8`,
    `  %text = load ptr, ptr %text.slot`,
    `  %length = call i64 @strlen(ptr %text)`,
    `  %wrote.text = call i64 @write(i32 2, ptr %text, i64 %length)`,
    `  %wrote.newline = call i64 @write(i32 2, ptr @sc_abort_frames.newline, i64 1)`,
    `  %previous = load ptr, ptr %frame`,
    `  %counted = add i32 %count, 1`,
    `  br label %next`,
    `out:`,
    `  ret void`,
    `}`,
    ``,
  ];
}
