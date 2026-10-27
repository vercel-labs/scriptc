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

/** A node table read as a preorder tree (AstWireFile.preorder): each
 * node's kind, with PREORDER_LIST for lists, and the end of its subtree. */
export interface AstPreorder {
  readonly kinds: Uint16Array;
  readonly ends: Uint32Array;
}

/** The kind AstPreorder records for a list (KIND_NODE_LIST on the wire). */
export const PREORDER_LIST = 0xffff;

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

/** Node fields as word offsets into a node's NODE_LEN bytes. */
const NODE_WORDS = NODE_LEN / 4;
const WORD_KIND = NODE_OFFSET_KIND / 4;
const WORD_POS = NODE_OFFSET_POS / 4;
const WORD_END = NODE_OFFSET_END / 4;
const WORD_NEXT = NODE_OFFSET_NEXT / 4;
const WORD_PARENT = NODE_OFFSET_PARENT / 4;
const WORD_DATA = NODE_OFFSET_DATA / 4;
const WORD_FLAGS = NODE_OFFSET_FLAGS / 4;
if (
  !Number.isInteger(NODE_WORDS) ||
  ![WORD_KIND, WORD_POS, WORD_END, WORD_NEXT, WORD_PARENT, WORD_DATA, WORD_FLAGS].every((word) =>
    Number.isInteger(word),
  )
)
  throw new AstDecodeError("node fields are not word-aligned");

/** Kept out of line, so the index check that calls it stays small enough
 * to inline into every node accessor. */
function invalidNodeIndex(index: number): never {
  throw new AstDecodeError(`invalid node index ${index}`);
}

/** Whether this host stores a Uint32Array's words little-endian, the wire's
 * byte order. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** `count` little-endian words of `bytes` from `offset`, which the caller has
 * bounds-checked: a view of the response when the words are aligned on a
 * little-endian host, a copy of their bytes when they are not, and a decoded
 * copy on a big-endian host. Where a section starts depends on the lengths of
 * the strings before it (file paths among them), so most files are unaligned. */
function astWords(bytes: Uint8Array, offset: number, count: number): Uint32Array {
  const start = bytes.byteOffset + offset;
  if (LITTLE_ENDIAN && start % 4 === 0) return new Uint32Array(bytes.buffer, start, count);
  const words = new Uint32Array(count);
  if (LITTLE_ENDIAN) new Uint8Array(words.buffer).set(bytes.subarray(offset, offset + count * 4));
  else for (let i = 0; i < count; i++) words[i] = astU32(bytes, offset + i * 4);
  return words;
}

/** TypeScript 7.1's encoding, which this reader accepts beside
 * PROTOCOL_VERSION (TypeScript 7.0's). Its header is 64 bytes: after the
 * section offsets come the source file ID and lease ID (u64 each) and the
 * binder data offset. Its node kinds count 7.1's SourceKeyword (167), so each
 * kind above it is one more than 7.0's; the reader returns 7.0's kinds. A
 * module declaration's children gain `attributes` in slot 2, which moves
 * `body` to slot 3, and an import clause's phase gains `source` (3). */
export const PROTOCOL_VERSION_7_1 = 9;
const HEADER_SIZE_7_1 = 64;
/** SourceKeyword in TypeScript 7.1's kinds. */
const SOURCE_KEYWORD_7_1 = 167;

/** A TypeScript 7.0 SyntaxKind as TypeScript 7.1 numbers it. */
export function syntaxKind71(kind: number): number {
  return kind >= SOURCE_KEYWORD_7_1 ? kind + 1 : kind;
}

/** The node table of a protocol 7.1 response in TypeScript 7.0's terms: each
 * kind above SourceKeyword one lower, and each module declaration's child
 * mask without the attributes slot. Throws for the nodes 7.0 has no form
 * for: a SourceKeyword node, a module declaration with import attributes,
 * and an `import source` clause. */
function wordsAs70(words: Uint32Array, count: number): Uint32Array {
  const result = new Uint32Array(words);
  for (let index = 1; index < count; index++) {
    const word = index * NODE_WORDS;
    let kind = result[word + WORD_KIND]!;
    if (kind === KIND_NODE_LIST) continue;
    if (kind === SOURCE_KEYWORD_7_1)
      throw new AstDecodeError("TypeScript 7.1's SourceKeyword node is not supported");
    if (kind > SOURCE_KEYWORD_7_1) result[word + WORD_KIND] = --kind;
    const data = result[word + WORD_DATA]!;
    if (kind === AstKind.ModuleDeclaration && data >>> 30 === 0) {
      if ((data & 4) !== 0)
        throw new AstDecodeError("import attributes on a module declaration are not supported");
      result[word + WORD_DATA] = ((data & ~0xff) | (data & 3) | ((data & 8) >>> 1)) >>> 0;
    } else if (kind === AstKind.ImportClause && ((data >>> 24) & 3) === 3) {
      throw new AstDecodeError("`import source` is not supported");
    }
  }
  return result;
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
  /** The response's protocol: PROTOCOL_VERSION or PROTOCOL_VERSION_7_1. */
  readonly protocol: number;
  private readonly strings: number;
  private readonly extended: number;
  private readonly structured: number;
  private readonly nodes: number;
  /** The node table as 32-bit words (astWords). */
  private readonly words: Uint32Array;
  /** The string table's start and end offsets, two words per string
   * (astWords). */
  private readonly stringWords: Uint32Array;
  /** Decoded strings by string word index / 2. */
  private readonly stringCache: (string | undefined)[];
  private preorderTree: AstPreorder | null | undefined;

  constructor(private readonly bytes: Uint8Array) {
    astBounds(bytes, 0, HEADER_SIZE);
    const metadata = astU32(bytes, HEADER_OFFSET_METADATA);
    const protocol = metadata >>> 24;
    if (protocol !== PROTOCOL_VERSION && protocol !== PROTOCOL_VERSION_7_1)
      throw new AstDecodeError(`unsupported protocol version ${protocol}`);
    this.protocol = protocol;
    const headerSize = protocol === PROTOCOL_VERSION_7_1 ? HEADER_SIZE_7_1 : HEADER_SIZE;
    astBounds(bytes, 0, headerSize);
    const stringOffsets = astU32(bytes, HEADER_OFFSET_STRING_TABLE_OFFSETS);
    this.strings = astU32(bytes, HEADER_OFFSET_STRING_TABLE);
    this.extended = astU32(bytes, HEADER_OFFSET_EXTENDED_DATA);
    this.structured = astU32(bytes, HEADER_OFFSET_STRUCTURED_DATA);
    this.nodes = astU32(bytes, HEADER_OFFSET_NODES);
    if (
      stringOffsets < headerSize ||
      this.strings < stringOffsets ||
      this.extended < this.strings ||
      this.structured < this.extended ||
      this.nodes < this.structured ||
      this.nodes > bytes.length ||
      (this.strings - stringOffsets) % 8 !== 0 ||
      (this.structured - this.extended) % 4 !== 0 ||
      (bytes.length - this.nodes) % NODE_LEN !== 0
    ) {
      throw new AstDecodeError("invalid section layout");
    }
    this.nodeCount = (bytes.length - this.nodes) / NODE_LEN;
    this.stringCount = (this.strings - stringOffsets) / 8;
    const words = astWords(bytes, this.nodes, this.nodeCount * NODE_WORDS);
    this.words = protocol === PROTOCOL_VERSION_7_1 ? wordsAs70(words, this.nodeCount) : words;
    this.stringWords = astWords(bytes, stringOffsets, this.stringCount * 2);
    this.stringCache = new Array<string | undefined>(this.stringCount).fill(undefined);
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
      const start = this.stringWords[i * 2]!;
      const end = this.stringWords[i * 2 + 1]!;
      if (end < start || end > this.extended - this.strings)
        throw new AstDecodeError("invalid string table offset");
    }
  }

  /** `kind` (TypeScript 7.0's) as this response's protocol numbers it, the
   * kind a node handle names. */
  kindOnWire(kind: number): number {
    return this.protocol === PROTOCOL_VERSION_7_1 ? syntaxKind71(kind) : kind;
  }

  /** A kind as this response's protocol numbers it (a node handle's) in
   * TypeScript 7.0's numbering; -1 for 7.1's SourceKeyword. */
  kindFromWire(kind: number): number {
    if (this.protocol !== PROTOCOL_VERSION_7_1 || kind < SOURCE_KEYWORD_7_1) return kind;
    return kind === SOURCE_KEYWORD_7_1 ? -1 : kind - 1;
  }

  /** The first word of node `index`. `index >>> 0 === index` accepts exactly
   * the integers in [0, 2^32), so with the bound it accepts the same indices
   * as an integer and range check. */
  private nodeWord(index: number): number {
    if (index >>> 0 !== index || index >= this.nodeCount) invalidNodeIndex(index);
    return index * NODE_WORDS;
  }

  // The constructor validates the complete fixed-width node table, and
  // nodeWord validates its index.
  kind(index: number): number {
    return this.words[this.nodeWord(index) + WORD_KIND]!;
  }
  pos(index: number): number {
    return this.words[this.nodeWord(index) + WORD_POS]! | 0;
  }
  end(index: number): number {
    return this.words[this.nodeWord(index) + WORD_END]! | 0;
  }
  flags(index: number): number {
    return this.words[this.nodeWord(index) + WORD_FLAGS]!;
  }
  data(index: number): number {
    return this.words[this.nodeWord(index) + WORD_DATA]!;
  }

  next(index: number): number {
    const next = this.words[this.nodeWord(index) + WORD_NEXT]!;
    if (next !== 0 && (next <= index || next >= this.nodeCount))
      throw new AstDecodeError("invalid sibling link");
    return next;
  }

  parent(index: number): number {
    const parent = this.words[this.nodeWord(index) + WORD_PARENT]!;
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
    if (index >>> 0 !== index || index % 2 !== 0 || index >= this.stringCount * 2)
      throw new AstDecodeError(`invalid string index ${index}`);
    const cached = this.stringCache[index >>> 1];
    if (cached !== undefined) return cached;
    const start = this.stringWords[index]!;
    const end = this.stringWords[index + 1]!;
    const text = decodeAstString(this.bytes, this.strings + start, end - start);
    this.stringCache[index >>> 1] = text;
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
    this.nodeWord(index);
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

  /** The node table as a preorder tree, built on first use: every node's
   * subtree is the index range up to `ends[index]`, and `kinds[index]` is its
   * kind. The pass checks the links the linked walk checks one child at a
   * time: each node's parent is open, the first child follows its parent,
   * each sibling link names the end of the previous sibling's subtree, a
   * last child has no sibling link, and each list holds `data` nodes and no
   * lists. null when any check fails; walks then follow the links and fail
   * where they read the inconsistent node. */
  preorder(): AstPreorder | null {
    if (this.preorderTree === undefined) this.preorderTree = this.buildPreorder();
    return this.preorderTree;
  }

  private buildPreorder(): AstPreorder | null {
    const count = this.nodeCount;
    const words = this.words;
    const kinds = new Uint16Array(count);
    const ends = new Uint32Array(count);
    // The nodes whose subtrees contain the current index, innermost last,
    // with the number of children each has so far.
    const open: number[] = [1];
    const children: number[] = [0];
    const rootKind = words[NODE_WORDS + WORD_KIND]!;
    if (rootKind >= PREORDER_LIST) return null;
    kinds[1] = rootKind;
    for (let index = 2; index <= count; index++) {
      const word = index * NODE_WORDS;
      const parent = index < count ? words[word + WORD_PARENT]! : 0;
      let previous = 0;
      while (open.length > 0 && open[open.length - 1] !== parent) {
        const closed = open.pop()!;
        const closedChildren = children.pop()!;
        ends[closed] = index;
        const closedWord = closed * NODE_WORDS;
        if (kinds[closed] === PREORDER_LIST && closedChildren !== words[closedWord + WORD_DATA]!)
          return null;
        if (open.length > 0 && open[open.length - 1] === parent) previous = closed;
        else if (closed !== 1 && words[closedWord + WORD_NEXT]! !== 0) return null;
      }
      if (index === count) break;
      if (open.length === 0 || parent >= index) return null;
      if (
        previous !== 0 ? words[previous * NODE_WORDS + WORD_NEXT]! !== index : index !== parent + 1
      )
        return null;
      const kind = words[word + WORD_KIND]!;
      if (kind === KIND_NODE_LIST) {
        if (kinds[parent] === PREORDER_LIST) return null;
        kinds[index] = PREORDER_LIST;
      } else {
        if (kind >= PREORDER_LIST) return null;
        kinds[index] = kind;
      }
      children[children.length - 1] = children[children.length - 1]! + 1;
      open.push(index);
      children.push(0);
    }
    return { kinds, ends };
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
      this.nodeWord(index);
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
