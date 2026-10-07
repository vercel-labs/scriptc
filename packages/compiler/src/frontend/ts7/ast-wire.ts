import {
  AstDecodeError,
  AstMsgpackReader,
  astBounds,
  astU32,
  decodeAstString,
} from "./ast-bytes.js";
import {
  AstKind,
  HEADER_OFFSET_EXTENDED_DATA,
  HEADER_OFFSET_HASH_HI0,
  HEADER_OFFSET_HASH_HI1,
  HEADER_OFFSET_HASH_LO0,
  HEADER_OFFSET_HASH_LO1,
  HEADER_OFFSET_METADATA,
  HEADER_OFFSET_NODES,
  HEADER_OFFSET_PARSE_OPTIONS,
  HEADER_OFFSET_STRING_TABLE,
  HEADER_OFFSET_STRING_TABLE_OFFSETS,
  HEADER_OFFSET_STRUCTURED_DATA,
  HEADER_SIZE,
  KIND_NODE_LIST,
  NODE_LEN,
  NODE_OFFSET_DATA,
  NODE_OFFSET_END,
  NODE_OFFSET_FLAGS,
  NODE_OFFSET_KIND,
  NODE_OFFSET_NEXT,
  NODE_OFFSET_PARENT,
  NODE_OFFSET_POS,
  PROTOCOL_VERSION,
  astChildOrder,
} from "./ast-schema.generated.js";

export interface AstFileReference {
  pos: number;
  end: number;
  fileName: string;
  resolutionMode: number;
  preserve: boolean;
}

export interface AstNodeHandle {
  index: number;
  kind: number;
  path: string;
}

function handleNumber(text: string): number {
  if (text.length === 0) throw new AstDecodeError("empty node handle component");
  let value = 0;
  for (let i = 0; i < text.length; i++) {
    const digit = text.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) throw new AstDecodeError("invalid node handle component");
    value = value * 10 + digit;
    if (value > 0xffffffff) throw new AstDecodeError("node handle component is too large");
  }
  return value;
}

export function parseAstNodeHandle(handle: string): AstNodeHandle {
  const first = handle.indexOf(".");
  const second = first < 0 ? -1 : handle.indexOf(".", first + 1);
  if (first < 0 || second < 0 || second === handle.length - 1)
    throw new AstDecodeError("invalid node handle");
  const index = handleNumber(handle.slice(0, first));
  if (index === 0) throw new AstDecodeError("node handle refers to the nil sentinel");
  return {
    index,
    kind: handleNumber(handle.slice(first + 1, second)),
    path: handle.slice(second + 1),
  };
}

function hexWord(value: number): string {
  const digits = "0123456789abcdef";
  let result = "";
  for (let shift = 28; shift >= 0; shift -= 4) result += digits.charAt((value >>> shift) & 15);
  return result;
}

/** A checked view of one immutable response. Node indices, rather than
 * object pointers, preserve the server's identity and avoid creating parent
 * cycles merely to inspect the tree. Object materialization sits above this
 * layer; the same reader runs in the Node and native compiler. */
export class AstWireFile {
  readonly nodeCount: number;
  readonly stringCount: number;
  readonly contentHash: string;
  readonly parseOptionsKey: string;
  private readonly stringOffsets: number;
  private readonly strings: number;
  private readonly extended: number;
  private readonly structured: number;
  private readonly nodes: number;
  private readonly view: DataView;
  private readonly stringCache = new Map<number, string>();

  constructor(private readonly bytes: Uint8Array) {
    astBounds(bytes, 0, HEADER_SIZE);
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metadata = astU32(bytes, HEADER_OFFSET_METADATA);
    if (metadata >>> 24 !== PROTOCOL_VERSION)
      throw new AstDecodeError(`unsupported protocol version ${metadata >>> 24}`);
    this.stringOffsets = astU32(bytes, HEADER_OFFSET_STRING_TABLE_OFFSETS);
    this.strings = astU32(bytes, HEADER_OFFSET_STRING_TABLE);
    this.extended = astU32(bytes, HEADER_OFFSET_EXTENDED_DATA);
    this.structured = astU32(bytes, HEADER_OFFSET_STRUCTURED_DATA);
    this.nodes = astU32(bytes, HEADER_OFFSET_NODES);
    if (
      this.stringOffsets < HEADER_SIZE ||
      this.strings < this.stringOffsets ||
      this.extended < this.strings ||
      this.structured < this.extended ||
      this.nodes < this.structured ||
      this.nodes > bytes.length ||
      (this.strings - this.stringOffsets) % 8 !== 0 ||
      (this.structured - this.extended) % 4 !== 0 ||
      (bytes.length - this.nodes) % NODE_LEN !== 0
    ) {
      throw new AstDecodeError("invalid section layout");
    }
    this.nodeCount = (bytes.length - this.nodes) / NODE_LEN;
    this.stringCount = (this.strings - this.stringOffsets) / 8;
    if (this.nodeCount < 2) throw new AstDecodeError("missing root");
    if (this.kind(1) === KIND_NODE_LIST || this.parent(1) > 1)
      throw new AstDecodeError("invalid root node");
    this.contentHash =
      hexWord(astU32(bytes, HEADER_OFFSET_HASH_HI1)) +
      hexWord(astU32(bytes, HEADER_OFFSET_HASH_HI0)) +
      hexWord(astU32(bytes, HEADER_OFFSET_HASH_LO1)) +
      hexWord(astU32(bytes, HEADER_OFFSET_HASH_LO0));
    this.parseOptionsKey = String(astU32(bytes, HEADER_OFFSET_PARSE_OPTIONS));
    // Each string has a start/end pair; identifiers can reuse slices of
    // source text, so pairs overlap and are not globally monotone. Handles
    // address words (0, 2, 4...), not pair ordinals.
    for (let i = 0; i < this.stringCount; i++) {
      const start = astU32(bytes, this.stringOffsets + i * 8);
      const end = astU32(bytes, this.stringOffsets + i * 8 + 4);
      if (end < start || end > this.extended - this.strings)
        throw new AstDecodeError("invalid string table offset");
    }
  }

  private nodeOffset(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.nodeCount)
      throw new AstDecodeError(`invalid node index ${index}`);
    return this.nodes + index * NODE_LEN;
  }

  // The constructor validates the complete fixed-width node table, and
  // nodeOffset validates its index. Read each word in one operation while
  // preserving little-endian decoding even in an unaligned byte view.
  kind(index: number): number {
    return this.view.getUint32(this.nodeOffset(index) + NODE_OFFSET_KIND, true);
  }
  pos(index: number): number {
    return this.view.getInt32(this.nodeOffset(index) + NODE_OFFSET_POS, true);
  }
  end(index: number): number {
    return this.view.getInt32(this.nodeOffset(index) + NODE_OFFSET_END, true);
  }
  flags(index: number): number {
    return this.view.getUint32(this.nodeOffset(index) + NODE_OFFSET_FLAGS, true);
  }
  data(index: number): number {
    return this.view.getUint32(this.nodeOffset(index) + NODE_OFFSET_DATA, true);
  }

  next(index: number): number {
    const next = this.view.getUint32(this.nodeOffset(index) + NODE_OFFSET_NEXT, true);
    if (next !== 0 && (next <= index || next >= this.nodeCount))
      throw new AstDecodeError("invalid sibling link");
    return next;
  }

  parent(index: number): number {
    const parent = this.view.getUint32(this.nodeOffset(index) + NODE_OFFSET_PARENT, true);
    if (parent >= this.nodeCount || (index <= 1 ? parent > index : parent >= index))
      throw new AstDecodeError("invalid parent link");
    return parent;
  }

  semanticParent(index: number): number {
    let parent = this.parent(index);
    while (parent !== 0 && this.kind(parent) === KIND_NODE_LIST) parent = this.parent(parent);
    return parent;
  }

  string(index: number): string {
    if (!Number.isInteger(index) || index < 0 || index % 2 !== 0 || index >= this.stringCount * 2)
      throw new AstDecodeError(`invalid string index ${index}`);
    const cached = this.stringCache.get(index);
    if (cached !== undefined) return cached;
    const start = astU32(this.bytes, this.stringOffsets + index * 4);
    const end = astU32(this.bytes, this.stringOffsets + (index + 1) * 4);
    const text = decodeAstString(this.bytes, this.strings + start, end - start);
    this.stringCache.set(index, text);
    return text;
  }

  extendedWord(index: number, offset: number): number {
    const data = this.data(index);
    if (data >>> 30 !== 2) throw new AstDecodeError("node does not have extended data");
    const start = (data & 0x00ffffff) + offset;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset % 4 !== 0 ||
      start > this.structured - this.extended - 4
    ) {
      throw new AstDecodeError("extended data exceeds its section");
    }
    return astU32(this.bytes, this.extended + start);
  }

  text(index: number): string | undefined {
    const kind = this.kind(index);
    switch (kind) {
      case AstKind.Identifier:
      case AstKind.PrivateIdentifier:
      case AstKind.JsxText:
      case AstKind.JSDocText:
      case AstKind.JSDocLink:
      case AstKind.JSDocLinkPlain:
      case AstKind.JSDocLinkCode:
        return this.string(this.data(index) & 0x00ffffff);
      case AstKind.StringLiteral:
      case AstKind.NumericLiteral:
      case AstKind.BigIntLiteral:
      case AstKind.RegularExpressionLiteral:
      case AstKind.NoSubstitutionTemplateLiteral:
      case AstKind.TemplateHead:
      case AstKind.TemplateMiddle:
      case AstKind.TemplateTail:
      case AstKind.SourceFile:
        return this.string(this.extendedWord(index, 0));
      default:
        return undefined;
    }
  }

  rawText(index: number): string | undefined {
    const kind = this.kind(index);
    return kind === AstKind.TemplateHead ||
      kind === AstKind.TemplateMiddle ||
      kind === AstKind.TemplateTail
      ? this.string(this.extendedWord(index, 4))
      : undefined;
  }

  firstChild(index: number): number {
    this.nodeOffset(index);
    return index + 1 < this.nodeCount && this.parent(index + 1) === index ? index + 1 : 0;
  }

  /** Lists and JSDoc containers remain visible here. forEachChild's semantic
   * flattening belongs in the object adapter, so names and raw node ids stay
   * stable for checker handles and structured reference arrays. */
  children(index: number): number[] {
    const result: number[] = [];
    for (let child = this.firstChild(index); child !== 0; child = this.next(child)) {
      if (this.parent(child) !== index)
        throw new AstDecodeError("sibling belongs to another parent");
      result.push(child);
    }
    return result;
  }

  list(index: number): number[] {
    if (this.kind(index) !== KIND_NODE_LIST) throw new AstDecodeError("expected a node list");
    const count = this.data(index);
    if (count > this.nodeCount - index - 1)
      throw new AstDecodeError("node list length exceeds the response");
    const children = this.children(index);
    if (children.length !== count)
      throw new AstDecodeError("node list length does not match its links");
    return children;
  }

  /** The semantic walk flattens lists and omits attached JSDoc trees.
   * Validate the same list links as list(), without materializing nodes
   * that a selective syntax scan will never inspect. */
  appendChildIndices(index: number, output: number[]): void {
    for (let child = this.firstChild(index); child !== 0; child = this.next(child)) {
      if (this.parent(child) !== index)
        throw new AstDecodeError("sibling belongs to another parent");
      const kind = this.kind(child);
      if (kind === KIND_NODE_LIST) {
        const count = this.data(child);
        if (count > this.nodeCount - child - 1)
          throw new AstDecodeError("node list length exceeds the response");
        const start = output.length;
        for (let item = this.firstChild(child); item !== 0; item = this.next(item)) {
          if (this.parent(item) !== child)
            throw new AstDecodeError("sibling belongs to another parent");
          if (this.kind(item) === KIND_NODE_LIST) throw new AstDecodeError("expected a node index");
          output.push(item);
        }
        if (output.length - start !== count)
          throw new AstDecodeError("node list length does not match its links");
      } else if (kind !== AstKind.JSDoc) {
        output.push(child);
      }
    }
  }

  namedChild(index: number, name: string): number {
    const order = astChildOrder(this.kind(index), name);
    return order < 0 ? 0 : this.childAtOrder(index, order);
  }

  childAtOrder(index: number, order: number): number {
    if (!Number.isInteger(order) || order < 0 || order >= 8)
      throw new AstDecodeError("invalid child slot");
    const data = this.data(index);
    const mask = data >>> 30 === 0 ? data & 0xff : 0xff;
    if ((mask & (1 << order)) === 0) return 0;
    let skip = 0;
    for (let bit = 0; bit < order; bit++) if ((mask & (1 << bit)) !== 0) skip++;
    let child = this.firstChild(index);
    while (skip > 0 && child !== 0) {
      child = this.next(child);
      skip--;
    }
    if (child === 0) throw new AstDecodeError("missing named child");
    if (this.parent(child) !== index)
      throw new AstDecodeError("named child belongs to another parent");
    return child;
  }

  structuredReader(offset: number): AstMsgpackReader {
    if (!Number.isInteger(offset) || offset < 0 || offset >= this.nodes - this.structured)
      throw new AstDecodeError("invalid structured data offset");
    return new AstMsgpackReader(this.bytes, this.structured + offset, this.nodes);
  }

  fileReferences(offset: number): AstFileReference[] {
    if (offset === 0xffffffff) return [];
    const reader = this.structuredReader(offset);
    const count = reader.arrayLength();
    const result: AstFileReference[] = [];
    for (let i = 0; i < count; i++) {
      if (reader.arrayLength() !== 5) throw new AstDecodeError("invalid file reference tuple");
      result.push({
        pos: reader.uint(),
        end: reader.uint(),
        fileName: reader.string(),
        resolutionMode: reader.uint(),
        preserve: reader.bool(),
      });
    }
    return result;
  }

  nodeIndices(offset: number): number[] {
    if (offset === 0xffffffff) return [];
    const reader = this.structuredReader(offset);
    const count = reader.arrayLength();
    const result: number[] = [];
    for (let i = 0; i < count; i++) {
      const index = reader.uint();
      this.nodeOffset(index);
      if (index === 0 || this.kind(index) === KIND_NODE_LIST)
        throw new AstDecodeError("structured reference is not a node");
      result.push(index);
    }
    return result;
  }

  stringArray(offset: number): string[] {
    if (offset === 0xffffffff) return [];
    const reader = this.structuredReader(offset);
    const count = reader.arrayLength();
    const result: string[] = [];
    for (let i = 0; i < count; i++) result.push(reader.string());
    return result;
  }
}
