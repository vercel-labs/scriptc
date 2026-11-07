import * as ts from "../ts7/adapter.js";

/** One decision of the indexed-read analysis: why it widened a binding,
 * parameter, return, or field to a runtime-optional representation, or why
 * an array element ABI can hold undefined values or holes. */
export interface RuntimeOptionalDecision {
  /** The kind of slot the decision widened, such as `binding` or
   * `parameter`; `element-<fact>` kinds describe an array element ABI. */
  kind: string;
  /** A qualifier such as an element key or a parameter note. */
  detail: string;
  /** The widened slot. */
  targetNode: ts.Node | undefined;
  /** The expression or site whose value made the slot optional. */
  causeNode: ts.Node | undefined;
}

/** Record of the indexed-read analysis's storage decisions. The coverage
 * report (`--explain-dynamic`) reads them through `decisions`; with
 * SCRIPTC_DEBUG_RUNTIME_OPTIONAL=1 the same entries are also written to
 * stderr, one line each. The disabled path records nothing. Not a public
 * API: the output format may change at any time. */
export class RuntimeOptionalProvenance {
  private readonly entries: RuntimeOptionalDecision[] = [];
  private readonly pending: string[] = [];
  private readonly seen = new Set<string>();

  private constructor(private readonly debug: boolean) {}

  /** The analysis runs in more than one pass over one lowerer; a single
   * recorder keeps the decisions of both in source order. */
  static forReport(): RuntimeOptionalProvenance {
    return new RuntimeOptionalProvenance(process.env["SCRIPTC_DEBUG_RUNTIME_OPTIONAL"] === "1");
  }

  static fromEnvironment(): RuntimeOptionalProvenance | null {
    return process.env["SCRIPTC_DEBUG_RUNTIME_OPTIONAL"] === "1"
      ? new RuntimeOptionalProvenance(true)
      : null;
  }

  decisions(): readonly RuntimeOptionalDecision[] {
    return this.entries;
  }

  /** `target` names the widened slot; `cause` is the expression or site
   * whose value made it optional. */
  note(kind: string, target: ts.Node | undefined, cause: ts.Node | undefined, detail = ""): void {
    const line = `${kind} ${describe(target)}${detail ? ` ${detail}` : ""} <- ${describe(cause)}`;
    if (this.seen.has(line)) return;
    this.seen.add(line);
    this.entries.push({ kind, detail, targetNode: target, causeNode: cause });
    if (this.debug) this.pending.push(line);
  }

  flush(): void {
    for (const line of this.pending) process.stderr.write(`scriptc runtime-optional ${line}\n`);
    this.pending.length = 0;
  }
}

function describe(node: ts.Node | undefined): string {
  if (!node) return "?";
  const sf = ts.getSourceFileOfNode(node);
  const start = ts.tokenStartOfNode(node);
  const pos = ts.getLineAndCharacterOfPosition(sf, start);
  const text = sf.text.slice(start, node.end).replace(/\s+/g, " ");
  const short = text.length > 60 ? `${text.slice(0, 57)}...` : text;
  return `${sf.fileName}:${pos.line + 1}:${pos.character + 1} \`${short}\``;
}
