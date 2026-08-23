/* The one structure the C emitter never needed: a basic-block builder
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

export class BlockBuilder {
  private readonly blocks: { label: string; lines: string[]; term: string | null }[] = [];
  private cur: { label: string; lines: string[]; term: string | null };
  /** Lines spliced into the head of the entry block at render time —
   * allocas (locals, result slots, the log-arg array) all live there so
   * every block is dominated by them. */
  readonly entryAllocas: string[] = [];
  private tempCounter = 0;
  private labelCounter = 0;

  constructor() {
    this.cur = { label: "entry", lines: [], term: null };
    this.blocks.push(this.cur);
  }

  newLabel(hint: string): string {
    return `${hint}${this.labelCounter++}`;
  }

  startBlock(label: string): void {
    this.cur = { label, lines: [], term: null };
    this.blocks.push(this.cur);
  }

  line(s: string): void {
    if (this.cur.term === null) this.cur.lines.push(`  ${s}`);
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
    if (this.cur.term === null) this.cur.term = `  ${s}`;
  }

  br(label: string): void {
    this.terminate(`br label %${label}`);
  }

  condBr(v: string, t: string, f: string): void {
    this.terminate(`br i1 ${v}, label %${t}, label %${f}`);
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
    return this.blocks
      .map((b, i) => {
        const lines = i === 0 ? [...this.entryAllocas.map((l) => `  ${l}`), ...b.lines] : b.lines;
        // A block left unterminated is a structurally unreachable join
        // (every predecessor jumped elsewhere); the verifier still wants a
        // terminator.
        const term = b.term ?? "  unreachable";
        return `${b.label}:\n${lines.join("\n")}${lines.length ? "\n" : ""}${term}`;
      })
      .join("\n");
  }
}
