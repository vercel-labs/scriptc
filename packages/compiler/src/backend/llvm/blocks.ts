/* LLVM basic-block builder
 * lowering the structured statement tree to labeled blocks with explicit
 * terminators. clang -O0 style — every local is an alloca, every read a
 * load — so no SSA construction is ever needed; LLVM's mem2reg promotes
 * the slots at -O2. Ported from the survey prototype (ll-emit.mjs).
 *
 * Terminator discipline: text after a terminator is unreachable — the C
 * emitter relies on the same property when a body ends in return (dead C
 * code after it); here the lines are DROPPED instead, and emitStmts skips
 * whole statements once the current block is terminated, so no dropped
 * definition can leak into a later block. */
import { UNWIND_RESUME, UNWIND_SLOT } from "./unwind-abi.js";

/** An inline dyn release call, and the comment that marks one emitted
 * inside a loop: the sites limitInlineReleases keeps inline first. */
export const DYN_RELEASE_CALL = "call void @sc_rc_release_dyn(";
export const LOOP_SITE = " ; loop";

export class BlockBuilder {
  private readonly blocks: { label: string; lines: string[]; term: string | null }[] = [];
  private cur: { label: string; lines: string[]; term: string | null };
  /** Lines spliced into the head of the entry block at render time —
   * allocas (locals, result slots, the log-arg array) all live there so
   * every block is dominated by them. */
  readonly entryAllocas: string[] = [];
  private tempCounter = 0;
  private labelCounter = 0;
  debugLocation: string | null = null;
  /** The body is a synchronous IR function: the active exception cell is one
   * value from entry to every pending check. Other builders (adapters,
   * runtime helpers) keep loading it at each check. */
  excCellInvariant = false;
  /** The entry-block load of the active exception cell, once requested. */
  excCell: string | null = null;
  /** Function epilogue shared by normal and exceptional returns. */
  returnEpilogue: string | null = null;
  /** Temps known to hold immortal values (temp names are only unique
   * within one builder). */
  readonly immortalTemps = new Set<string>();
  /** Entry slots whose loads and stores render volatile, so no LLVM pass
   * promotes them to SSA values (see volatileSlotAccess). */
  volatileSlots: ReadonlySet<string> | null = null;
  /** Loops of the IR function enclosing the lines being emitted; inline dyn
   * releases inside one carry LOOP_SITE (shapes.ts limitInlineReleases). */
  loopDepth = 0;

  constructor() {
    this.cur = { label: "entry", lines: [], term: null };
    this.blocks.push(this.cur);
  }

  newLabel(hint: string): string {
    return `${hint}${this.labelCounter++}`;
  }

  /** The label of the block instructions currently append to. */
  currentLabel(): string {
    return this.cur.label;
  }

  startBlock(label: string): void {
    this.cur = { label, lines: [], term: null };
    this.blocks.push(this.cur);
  }

  line(s: string): void {
    if (this.cur.term === null) {
      const marked = this.loopDepth > 0 && s.startsWith(DYN_RELEASE_CALL) ? s + LOOP_SITE : s;
      this.cur.lines.push(`  ${this.withDebugLocation(marked)}`);
    }
  }

  private withDebugLocation(s: string): string {
    if (this.debugLocation === null || s.trimStart().startsWith(";")) return s;
    // Instruction comments must follow the attachment. Quoted LLVM operands
    // can themselves contain semicolons; those are not comment delimiters.
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
      if (s.charAt(i) === '"') quoted = !quoted;
      if (s.charAt(i) === ";" && !quoted) {
        return `${s.slice(0, i).trimEnd()}, !dbg ${this.debugLocation} ${s.slice(i)}`;
      }
    }
    return `${s}, !dbg ${this.debugLocation}`;
  }

  tmp(): string {
    return `%t${this.tempCounter++}`;
  }

  slot(): string {
    return `%s${this.tempCounter++}`;
  }

  isTerminated(): boolean {
    return this.cur.term !== null;
  }

  terminate(s: string): void {
    if (this.cur.term === null) {
      if (
        this.returnEpilogue &&
        (s.startsWith("ret ") ||
          s.startsWith("call void @scr_unwind_raise()") ||
          s === UNWIND_RESUME)
      )
        this.line(this.returnEpilogue);
      if (s === UNWIND_RESUME) {
        const exception = this.tmp();
        this.line(`${exception} = load { ptr, i32 }, ptr ${UNWIND_SLOT}`);
        this.resumeUnwind(exception);
        return;
      }
      this.cur.term = `  ${this.withDebugLocation(s)}`;
    }
  }

  /** Ends the block by continuing an unwind with `exception`, the value
   * of a landing pad (UNWIND_RESUME_DECLARATION). */
  resumeUnwind(exception: string): void {
    const token = this.tmp();
    this.line(`${token} = extractvalue { ptr, i32 } ${exception}, 0`);
    this.line(`call void @scr_unwind_resume(ptr ${token})`);
    this.terminate("unreachable");
  }

  br(label: string, attachment = ""): void {
    this.terminate(`br label %${label}${attachment}`);
  }

  condBr(v: string, t: string, f: string, attachment = ""): void {
    this.terminate(`br i1 ${v}, label %${t}, label %${f}${attachment}`);
  }

  /** Emit a double-indexed `for (i = 0; i < len; i++)` loop. `next` is
   * exposed for bodies with internal branches that need to continue at the
   * shared increment block. */
  countedLoop(
    len: string,
    emitBody: (index: string, next: string) => void,
    comparison: "olt" | "ole" = "olt",
  ): void {
    const indexSlot = this.slot();
    this.entryAllocas.push(`${indexSlot} = alloca double`);
    this.line(`store double 0x0000000000000000, ptr ${indexSlot}`);
    const condition = this.newLabel("count.c");
    const body = this.newLabel("count.b");
    const next = this.newLabel("count.n");
    const done = this.newLabel("count.e");
    this.br(condition);
    this.startBlock(condition);
    const index = this.tmp();
    const more = this.tmp();
    this.line(`${index} = load double, ptr ${indexSlot}`);
    this.line(`${more} = fcmp ${comparison} double ${index}, ${len}`);
    this.condBr(more, body, done);
    this.startBlock(body);
    emitBody(index, next);
    if (!this.isTerminated()) this.br(next);
    this.startBlock(next);
    const incremented = this.tmp();
    this.line(`${incremented} = fadd double ${index}, 0x3FF0000000000000`);
    this.line(`store double ${incremented}, ptr ${indexSlot}`);
    this.br(condition);
    this.startBlock(done);
  }

  render(): string {
    const slots = this.volatileSlots;
    return this.blocks
      .map((b, i) => {
        const body =
          slots === null || slots.size === 0
            ? b.lines
            : b.lines.map((line) => volatileSlotAccess(line, slots));
        const lines = i === 0 ? [...this.entryAllocas.map((l) => `  ${l}`), ...body] : body;
        // A block left unterminated is a structurally unreachable join
        // (every predecessor jumped elsewhere); the verifier still wants a
        // terminator.
        const term = b.term ?? "  unreachable";
        return `${b.label}:\n${lines.join("\n")}${lines.length ? "\n" : ""}${term}`;
      })
      .join("\n");
  }
}

/** `line` with its load or store made volatile when the address operand is
 * one of `slots`. Lines are this builder's own instruction text, where the
 * address is the first `ptr %name` operand after the opcode (a stored value
 * precedes it without a comma). */
export function volatileSlotAccess(line: string, slots: ReadonlySet<string>): string {
  let op = 0;
  while (line.charCodeAt(op) === 32) op++;
  if (line.charCodeAt(op) === 37) {
    const assign = line.indexOf(" = ", op);
    if (assign < 0) return line;
    op = assign + 3;
  }
  const kind = line.startsWith("load ", op) ? 5 : line.startsWith("store ", op) ? 6 : 0;
  if (kind === 0 || line.startsWith("volatile ", op + kind)) return line;
  const address = line.indexOf(", ptr %", op + kind);
  if (address < 0) return line;
  const start = address + 6;
  let end = start + 1;
  while (end < line.length && isNameCode(line.charCodeAt(end))) end++;
  if (!slots.has(line.slice(start, end))) return line;
  return `${line.slice(0, op + kind)}volatile ${line.slice(op + kind)}`;
}

function isNameCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 46
  );
}
