/* DOMException — the web-standard error shape (a Node global since
 * v17): an Error subclass whose `code` is the WebIDL legacy NUMBER
 * (InvalidCharacterError = 5, 0 for off-table names) and whose options
 * form carries `cause`. `new DOMException(msg)` has name "Error" like
 * the spec's default. Subclassing is fenced (the runtime layout carries
 * hidden slots) — extend Error instead.
 *
 * The same declaration as in scriptc-node-fallback.d.ts, for the one program
 * that file is not part of and that still needs the name: a project whose
 * own @types/node declares no DOMException global (20.11 and earlier), when
 * the program holds one of scriptc's package implementations, which name the
 * global (frontend/program.ts, nodeTypesSupplementRoots7). The fallback
 * declarations keep their own copy, in its place among the other globals: a
 * program's list of global names follows declaration order, so moving it
 * would change programs that have nothing to do with this.
 * packages/compiler/test/node-fallback-modules.test.ts keeps the two equal. */
interface DOMException extends Error {
  readonly code: number;
}
declare var DOMException: {
  new (message?: unknown, nameOrOptions?: unknown): DOMException;
  readonly prototype: DOMException;
  readonly INDEX_SIZE_ERR: number;
  readonly DOMSTRING_SIZE_ERR: number;
  readonly HIERARCHY_REQUEST_ERR: number;
  readonly WRONG_DOCUMENT_ERR: number;
  readonly INVALID_CHARACTER_ERR: number;
  readonly NO_DATA_ALLOWED_ERR: number;
  readonly NO_MODIFICATION_ALLOWED_ERR: number;
  readonly NOT_FOUND_ERR: number;
  readonly NOT_SUPPORTED_ERR: number;
  readonly INUSE_ATTRIBUTE_ERR: number;
  readonly INVALID_STATE_ERR: number;
  readonly SYNTAX_ERR: number;
  readonly INVALID_MODIFICATION_ERR: number;
  readonly NAMESPACE_ERR: number;
  readonly INVALID_ACCESS_ERR: number;
  readonly VALIDATION_ERR: number;
  readonly TYPE_MISMATCH_ERR: number;
  readonly SECURITY_ERR: number;
  readonly NETWORK_ERR: number;
  readonly ABORT_ERR: number;
  readonly URL_MISMATCH_ERR: number;
  readonly QUOTA_EXCEEDED_ERR: number;
  readonly TIMEOUT_ERR: number;
  readonly INVALID_NODE_TYPE_ERR: number;
  readonly DATA_CLONE_ERR: number;
};
