import { llvmQuoted as quoted } from "../literals.js";
import { basename, dirname } from "node:path";
import {
  isUnitType,
  typeKey,
  type IrFunction,
  type IrGlobal,
  type IrLocal,
  type IrType,
  type IrUnionDef,
  type SrcLoc,
} from "../../ir/ir.js";
import { SourceLocations } from "../source-locations.js";
import { mangleFunction } from "../mangle.js";

/** A request a range emitter made of its debug info that added nodes
 * (LlvmDebugInfo.record), with the ids it answered. */
export type DebugRequest =
  | { readonly op: "function"; readonly fn: string; readonly result: string }
  | {
      readonly op: "local";
      readonly local: IrLocal;
      readonly fn: string;
      readonly arg: number;
      readonly captured: boolean;
      readonly result: { variable: string; location: string };
    }
  | {
      readonly op: "location";
      readonly loc: SrcLoc;
      readonly fn: string;
      readonly result: string;
    };

/** DWARF describes source bindings at their actual native storage locations.
 *
 * Nodes are numbered in request order. A range emitter (emit-module.ts)
 * records the requests that added nodes; the emitter that merges the range
 * replays them in order, so every node gets the number serial emission
 * gives it, and renames the range's text from the ids the range answered to
 * its own. A request that added no node answered an id that existed before
 * the range started or that an earlier recorded request created. */
export class LlvmDebugInfo {
  private readonly nodes: string[] = [];
  /** The requests that added nodes, while recording (record). */
  private requests: DebugRequest[] | null = null;
  private readonly files = new Map<string, string>();
  private readonly locations = new Map<string, string>();
  private readonly scopes = new Map<string, string>();
  private readonly lexicalScopes = new Map<string, { loc: SrcLoc; id: string }[]>();
  private readonly types = new Map<string, string>();
  private readonly units = new Map<string, { id: string; globalList: string; globals: string[] }>();
  private readonly source: SourceLocations;
  private readonly version: string;
  private readonly dwarf: string;

  constructor(
    sourceFile: string,
    sources: ReadonlyMap<string, string>,
    private readonly pointerBits = 64,
    private readonly unions: readonly IrUnionDef[] = [],
    /** Unions whose values are the nullable arm pointer itself. */
    private readonly nullableArms: ReadonlyMap<string, IrType> = new Map(),
  ) {
    this.source = new SourceLocations(sources);
    this.unit(sourceFile);
    this.version = this.add('!{i32 2, !"Debug Info Version", i32 3}');
    this.dwarf = this.add('!{i32 2, !"Dwarf Version", i32 4}');
  }

  private add(node: string): string {
    const id = `!${this.nodes.length}`;
    this.nodes.push(`${id} = ${node}`);
    return id;
  }

  private file(path: string): string {
    let file = this.files.get(path);
    if (file === undefined) {
      file = this.add(
        `!DIFile(filename: ${quoted(basename(path))}, directory: ${quoted(dirname(path))})`,
      );
      this.files.set(path, file);
    }
    return file;
  }

  private unit(path: string): { id: string; globalList: string; globals: string[] } {
    // Distinct source modules need distinct CUs even though code generation
    // shares one LLVM module; otherwise debuggers conflate file-local names.
    let unit = this.units.get(path);
    if (unit === undefined) {
      const file = this.file(path);
      const globalList = this.add("!{}");
      const id = this.add(
        `distinct !DICompileUnit(language: DW_LANG_C11, file: ${file}, producer: "scriptc", isOptimized: false, runtimeVersion: 0, emissionKind: FullDebug, globals: ${globalList})`,
      );
      unit = { id, globalList, globals: [] };
      this.units.set(path, unit);
    }
    return unit;
  }

  /** Records the requests that add nodes from here on. */
  record(): void {
    this.requests = [];
  }

  /** The requests recorded since record. */
  recorded(): readonly DebugRequest[] {
    return this.requests ?? [];
  }

  /** Replays a range's recorded requests in order and adds to `ids` the
   * rename from the ids the range answered to this debug info's. */
  replay(
    requests: readonly DebugRequest[],
    functionNamed: (name: string) => IrFunction,
    ids: Map<string, string>,
  ): void {
    const own = (id: string, to: string | null | undefined): void => {
      if (to === null || to === undefined)
        throw new Error(`llvm emitter bug: debug request for ${id} added no node on replay`);
      if (to !== id) ids.set(id, to);
    };
    for (const request of requests) {
      if (request.op === "function") {
        own(request.result, this.function(functionNamed(request.fn)));
        continue;
      }
      const fn = ids.get(request.fn) ?? request.fn;
      if (request.op === "location") {
        own(request.result, this.location(request.loc, fn));
        continue;
      }
      const local = this.local(request.local, fn, request.arg, request.captured);
      own(request.result.variable, local?.variable);
      own(request.result.location, local?.location);
    }
  }

  function(fn: IrFunction): string | null {
    const before = this.nodes.length;
    const id = this.functionNode(fn);
    if (this.requests !== null && id !== null && this.nodes.length > before)
      this.requests.push({ op: "function", fn: fn.name, result: id });
    return id;
  }

  private functionNode(fn: IrFunction): string | null {
    const pos = this.source.position(fn.loc);
    if (pos === null) return null;
    const file = this.file(pos.file);
    const signature = this.add(
      `!DISubroutineType(types: ${this.add(`!{${[fn.returnType, ...fn.params.map((p) => p.type)].map((t) => this.type(t)).join(", ")}}`)})`,
    );
    const id = this.add(
      `distinct !DISubprogram(name: ${quoted(fn.name)}, linkageName: ${quoted(mangleFunction(fn.name))}, scope: ${file}, file: ${file}, line: ${pos.line}, type: ${signature}, scopeLine: ${pos.line}, spFlags: DISPFlagLocalToUnit | DISPFlagDefinition, unit: ${this.unit(pos.file).id})`,
    );
    const scopes: { loc: SrcLoc; id: string }[] = [];
    this.lexicalScopes.set(id, scopes);
    const captures = new Set(
      [...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map((c) => c.localId),
    );
    const spans = fn.locals
      .filter((local) => !captures.has(local.id))
      .flatMap((local) => (local.source ? [local.source.scope] : []));
    // Outer scopes first; declarations in flattened IR still retain their
    // source block, loop, catch, or function scope (including hoisted var).
    spans.sort((a, b) => b.end - b.start - (a.end - a.start));
    for (const loc of spans) {
      if (
        loc.file !== fn.loc.file ||
        (fn.loc.end > fn.loc.start && (loc.start <= fn.loc.start || loc.end > fn.loc.end))
      )
        continue;
      if (scopes.some((scope) => scope.loc.start === loc.start && scope.loc.end === loc.end))
        continue;
      const start = this.source.position(loc);
      if (start === null) continue;
      const parent = this.scopeAt(loc, id);
      scopes.push({
        loc,
        id: this.add(
          `distinct !DILexicalBlock(scope: ${parent}, file: ${file}, line: ${start.line}, column: ${Math.min(start.column, 65535)})`,
        ),
      });
    }
    return id;
  }

  private scopeAt(loc: SrcLoc, fn: string): string {
    const scopes = this.lexicalScopes.get(fn) ?? [];
    return (
      scopes.findLast(
        (scope) =>
          scope.loc.file === loc.file && scope.loc.start <= loc.start && loc.end <= scope.loc.end,
      )?.id ?? fn
    );
  }

  private pointer(base: string): string {
    return this.add(
      `!DIDerivedType(tag: DW_TAG_pointer_type, baseType: ${base}, size: ${this.pointerBits})`,
    );
  }

  private type(type: IrType): string {
    if (type.kind === "void") return "null";
    const key = typeKey(type);
    const known = this.types.get(key);
    if (known !== undefined) return known;
    let id: string;
    switch (type.kind) {
      case "f64":
      case "procStream":
        id = this.add(
          `!DIBasicType(name: ${quoted(type.kind === "f64" ? "number" : type.kind)}, size: 64, encoding: DW_ATE_float)`,
        );
        break;
      case "bool":
        id = this.add('!DIBasicType(name: "boolean", size: 8, encoding: DW_ATE_boolean)');
        break;
      case "string": {
        const size = this.add(
          `!DIBasicType(name: "size_t", size: ${this.pointerBits}, encoding: DW_ATE_unsigned)`,
        );
        const char = this.add('!DIBasicType(name: "char", size: 8, encoding: DW_ATE_signed_char)');
        const data = this.add(
          `!DICompositeType(tag: DW_TAG_array_type, baseType: ${char}, elements: ${this.add(`!{${this.add("!DISubrange(count: -1)")}}`)})`,
        );
        const fields = ["rc", "len", "cap", "data"].map((name, i) =>
          this.add(
            `!DIDerivedType(tag: DW_TAG_member, name: ${quoted(name)}, baseType: ${i === 3 ? data : size}, size: ${i === 3 ? 0 : this.pointerBits}, offset: ${i * this.pointerBits})`,
          ),
        );
        id = this.pointer(
          this.add(
            `!DICompositeType(tag: DW_TAG_structure_type, name: "ScrStr", size: ${3 * this.pointerBits}, elements: ${this.add(`!{${fields.join(", ")}}`)})`,
          ),
        );
        break;
      }
      case "union": {
        const nullableArm = this.nullableArms.get(type.unionId);
        if (nullableArm) {
          // NULL is the unit arm; any other value is the arm's instance.
          id = this.type(nullableArm);
          break;
        }
        const arms = this.unions.find((union) => union.id === type.unionId)?.arms ?? [];
        const tags = arms.map((arm, i) =>
          this.add(`!DIEnumerator(name: ${quoted(typeKey(arm))}, value: ${i}, isUnsigned: true)`),
        );
        const uint = this.add(
          '!DIBasicType(name: "uint32_t", size: 32, encoding: DW_ATE_unsigned)',
        );
        const tag = this.add(
          `!DICompositeType(tag: DW_TAG_enumeration_type, name: ${quoted(`${type.unionId}_tag`)}, baseType: ${uint}, size: 32, elements: ${this.add(`!{${tags.join(", ")}}`)})`,
        );
        const members = arms.flatMap((arm, i) =>
          isUnitType(arm)
            ? []
            : [
                this.add(
                  `!DIDerivedType(tag: DW_TAG_member, name: "arm${i}", baseType: ${this.type(arm)}, size: ${arm.kind === "bool" ? 8 : arm.kind === "f64" ? 64 : this.pointerBits})`,
                ),
              ],
        );
        const slot = this.add(
          `!DICompositeType(tag: DW_TAG_union_type, name: ${quoted(`${type.unionId}_value`)}, size: 64, elements: ${this.add(`!{${members.join(", ")}}`)})`,
        );
        const offset = this.pointerBits === 32 ? 24 : 40;
        const fields = [
          this.add(
            `!DIDerivedType(tag: DW_TAG_member, name: "tag", baseType: ${tag}, size: 32, offset: ${this.pointerBits})`,
          ),
          this.add(
            `!DIDerivedType(tag: DW_TAG_member, name: "slot", baseType: ${slot}, size: 64, offset: ${offset * 8})`,
          ),
        ];
        id = this.pointer(
          this.add(
            `!DICompositeType(tag: DW_TAG_structure_type, name: ${quoted(`ScrUnion_${type.unionId}`)}, size: ${(offset + 8) * 8}, elements: ${this.add(`!{${fields.join(", ")}}`)})`,
          ),
        );
        break;
      }
      default:
        // Do not invent object layouts: unsupported visualizations remain
        // typed opaque pointers, never doubles read out of pointer slots.
        id = this.pointer(
          this.add(
            `!DICompositeType(tag: DW_TAG_structure_type, name: ${quoted(key)}, flags: DIFlagFwdDecl)`,
          ),
        );
    }
    this.types.set(key, id);
    return id;
  }

  local(
    local: IrLocal,
    fn: string | null,
    arg = 0,
    captured = false,
  ): { variable: string; expression: string; location: string } | null {
    const before = this.nodes.length;
    const result = this.localNodes(local, fn, arg, captured);
    if (this.requests !== null && fn !== null && result !== null && this.nodes.length > before)
      this.requests.push({
        op: "local",
        local,
        fn,
        arg,
        captured,
        result: { variable: result.variable, location: result.location },
      });
    return result;
  }

  private localNodes(
    local: IrLocal,
    fn: string | null,
    arg: number,
    captured: boolean,
  ): { variable: string; expression: string; location: string } | null {
    if (fn === null || local.source === undefined) return null;
    const pos = this.source.position(local.source.loc);
    if (pos === null) return null;
    const scope = captured ? fn : this.scopeAt(local.source.scope, fn);
    // Scalar forward captures use an array-backed TDZ box. Expose that
    // exceptional representation opaquely rather than reporting a bad value.
    const opaqueBox =
      local.boxed && local.tdz && (local.type.kind === "f64" || local.type.kind === "bool");
    const type = opaqueBox
      ? this.pointer(
          this.add(
            '!DICompositeType(tag: DW_TAG_structure_type, name: "ScrBox", flags: DIFlagFwdDecl)',
          ),
        )
      : this.type(local.type);
    const variable = this.add(
      `!DILocalVariable(name: ${quoted(local.name)}, ${arg === 0 ? "" : `arg: ${arg}, `}scope: ${scope}, file: ${this.file(pos.file)}, line: ${pos.line}, type: ${type})`,
    );
    // ScrBox.slot follows rc, kind, and three function pointers, aligned to
    // uint64_t on both the native and wasm32 runtime ABIs.
    const boxOffset = this.pointerBits === 32 ? 24 : 40;
    const expression =
      local.boxed && !opaqueBox
        ? `!DIExpression(DW_OP_deref, DW_OP_plus_uconst, ${boxOffset})`
        : "!DIExpression()";
    const location = this.add(
      `!DILocation(line: ${pos.line}, column: ${Math.min(pos.column, 65535)}, scope: ${scope})`,
    );
    return { variable, expression, location };
  }

  global(global: IrGlobal): string | null {
    if (global.source === undefined) return null;
    const pos = this.source.position(global.source.loc);
    if (pos === null) return null;
    const file = this.file(pos.file);
    const unit = this.unit(pos.file);
    const variable = this.add(
      `distinct !DIGlobalVariable(name: ${quoted(global.name)}, scope: ${unit.id}, file: ${file}, line: ${pos.line}, type: ${this.type(global.type)}, isLocal: true, isDefinition: true)`,
    );
    const expression = this.add(
      `!DIGlobalVariableExpression(var: ${variable}, expr: !DIExpression())`,
    );
    unit.globals.push(expression);
    return expression;
  }

  location(loc: SrcLoc, fn: string | null): string | null {
    const before = this.nodes.length;
    const id = this.locationNode(loc, fn);
    if (this.requests !== null && fn !== null && id !== null && this.nodes.length > before)
      this.requests.push({ op: "location", loc, fn, result: id });
    return id;
  }

  private locationNode(loc: SrcLoc, fn: string | null): string | null {
    if (fn === null) return null;
    const pos = this.source.position(loc);
    if (pos === null) return null;
    // Initializers and compiler-generated entry wrappers can span files.
    const lexical = this.scopeAt(loc, fn);
    const scopeKey = `${lexical}:${pos.file}`;
    let scope = this.scopes.get(scopeKey);
    if (scope === undefined) {
      scope = this.add(
        `!DILexicalBlockFile(scope: ${lexical}, file: ${this.file(pos.file)}, discriminator: 0)`,
      );
      this.scopes.set(scopeKey, scope);
    }
    const key = `${scope}:${pos.line}:${pos.column}`;
    let id = this.locations.get(key);
    if (id === undefined) {
      id = this.add(
        `!DILocation(line: ${pos.line}, column: ${Math.min(pos.column, 65535)}, scope: ${scope})`,
      );
      this.locations.set(key, id);
    }
    return id;
  }

  render(): string {
    for (const unit of this.units.values()) {
      this.nodes[Number(unit.globalList.slice(1))] =
        `${unit.globalList} = !{${unit.globals.join(", ")}}`;
    }
    return [
      `!llvm.dbg.cu = !{${[...this.units.values()].map((unit) => unit.id).join(", ")}}`,
      `!llvm.module.flags = !{${this.version}, ${this.dwarf}}`,
      ...this.nodes,
    ].join("\n");
  }
}
