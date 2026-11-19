/* node:sqlite — the synchronous SQLite surface (DatabaseSync, StatementSync,
 * sessions, tagged stores, user functions) over the SQLite engine Node ships,
 * vendored here (packages/runtime/vendor/sqlite) so compiled binaries query
 * the same SQLite version with the same compile options. The classes are
 * native checked-dynamic handles: their methods and getters dispatch through
 * the handle, and importing "node:sqlite" without reaching a lowered member
 * links neither the engine nor its unit. Prefix-only in Node too:
 * require("sqlite") is MODULE_NOT_FOUND. */
declare module "node:sqlite" {
  type SQLInputValue = null | number | bigint | string | ScriptcBufferView;
  type SQLOutputValue = null | number | bigint | string | Uint8Array;
  interface DatabaseSyncOptions {
    open?: boolean | undefined;
    readOnly?: boolean | undefined;
    enableForeignKeyConstraints?: boolean | undefined;
    enableDoubleQuotedStringLiterals?: boolean | undefined;
    allowExtension?: boolean | undefined;
    timeout?: number | undefined;
    readBigInts?: boolean | undefined;
    returnArrays?: boolean | undefined;
    allowBareNamedParameters?: boolean | undefined;
    allowUnknownNamedParameters?: boolean | undefined;
    defensive?: boolean | undefined;
    limits?: Partial<Record<string, number>> | undefined;
  }
  interface StatementSyncOptions {
    readBigInts?: boolean | undefined;
    returnArrays?: boolean | undefined;
    allowBareNamedParameters?: boolean | undefined;
    allowUnknownNamedParameters?: boolean | undefined;
  }
  interface FunctionOptions {
    useBigIntArguments?: boolean | undefined;
    varargs?: boolean | undefined;
    deterministic?: boolean | undefined;
    directOnly?: boolean | undefined;
  }
  interface AggregateOptions<T extends SQLInputValue = SQLInputValue> {
    start?: T | ((...args: T[]) => T) | undefined;
    step: (accumulator: T, ...args: T[]) => T;
    inverse?: ((accumulator: T, ...args: T[]) => T) | undefined;
    result?: ((accumulator: T) => SQLInputValue) | undefined;
  }
  interface CreateSessionOptions {
    db?: string | undefined;
    table?: string | undefined;
  }
  interface ApplyChangesetOptions {
    filter?: ((tableName: string) => boolean) | undefined;
    onConflict?: ((conflictType: number) => number) | undefined;
  }
  interface BackupOptions {
    source?: string | undefined;
    target?: string | undefined;
    rate?: number | undefined;
    progress?: ((progressInfo: BackupProgressInfo) => void) | undefined;
  }
  interface BackupProgressInfo {
    totalPages: number;
    remainingPages: number;
  }
  interface DatabaseSyncLimits {
    length: number;
    sqlLength: number;
    column: number;
    exprDepth: number;
    compoundSelect: number;
    vdbeOp: number;
    functionArg: number;
    attach: number;
    likePatternLength: number;
    variableNumber: number;
    triggerDepth: number;
  }
  interface StatementColumnMetadata {
    column: string | null;
    database: string | null;
    name: string;
    table: string | null;
    type: string | null;
  }
  interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }
  /** The iterator `StatementSync.iterate()` answers: `next()` steps the
   * statement, `return()` ends the iteration, and the iterator is its own
   * iterable. */
  interface StatementSyncIterator<T> extends IterableIterator<T> {
    return(value?: unknown): IteratorResult<T>;
    [Symbol.iterator](): StatementSyncIterator<T>;
  }
  class StatementSync {
    private constructor();
    all(
      namedParameters: Record<string, SQLInputValue>,
      ...anonymousParameters: SQLInputValue[]
    ): Record<string, SQLOutputValue>[];
    all(...anonymousParameters: SQLInputValue[]): Record<string, SQLOutputValue>[];
    columns(): StatementColumnMetadata[];
    readonly expandedSQL: string;
    get(
      namedParameters: Record<string, SQLInputValue>,
      ...anonymousParameters: SQLInputValue[]
    ): Record<string, SQLOutputValue> | undefined;
    get(...anonymousParameters: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    iterate(
      namedParameters: Record<string, SQLInputValue>,
      ...anonymousParameters: SQLInputValue[]
    ): StatementSyncIterator<Record<string, SQLOutputValue>>;
    iterate(
      ...anonymousParameters: SQLInputValue[]
    ): StatementSyncIterator<Record<string, SQLOutputValue>>;
    run(
      namedParameters: Record<string, SQLInputValue>,
      ...anonymousParameters: SQLInputValue[]
    ): StatementResultingChanges;
    run(...anonymousParameters: SQLInputValue[]): StatementResultingChanges;
    setAllowBareNamedParameters(enabled: boolean): void;
    setAllowUnknownNamedParameters(enabled: boolean): void;
    setReturnArrays(enabled: boolean): void;
    setReadBigInts(enabled: boolean): void;
    readonly sourceSQL: string;
    close(): void;
    [Symbol.dispose](): void;
  }
  interface Session {
    changeset(): Uint8Array;
    patchset(): Uint8Array;
    close(): void;
    [Symbol.dispose](): void;
  }
  interface SQLTagStore {
    run(
      stringElements: TemplateStringsArray,
      ...boundParameters: SQLInputValue[]
    ): StatementResultingChanges;
    get(
      stringElements: TemplateStringsArray,
      ...boundParameters: SQLInputValue[]
    ): Record<string, SQLOutputValue> | undefined;
    all(
      stringElements: TemplateStringsArray,
      ...boundParameters: SQLInputValue[]
    ): Record<string, SQLOutputValue>[];
    iterate(
      stringElements: TemplateStringsArray,
      ...boundParameters: SQLInputValue[]
    ): StatementSyncIterator<Record<string, SQLOutputValue>>;
    clear(): void;
    readonly size: number;
    readonly capacity: number;
    readonly db: DatabaseSync;
  }
  class DatabaseSync implements Disposable {
    constructor(path: string | ScriptcBufferView | URL, options?: DatabaseSyncOptions);
    aggregate<T extends SQLInputValue>(name: string, options: AggregateOptions<T>): void;
    close(): void;
    loadExtension(path: string, entryPoint?: string): void;
    enableLoadExtension(allow: boolean): void;
    enableDefensive(active: boolean): void;
    setAuthorizer(
      callback:
        | ((
            actionCode: number,
            p1: string | null,
            p2: string | null,
            p3: string | null,
            p4: string | null,
          ) => number)
        | null,
    ): void;
    location(dbName?: string): string | null;
    exec(sql: string): void;
    function(name: string, func: (...args: SQLOutputValue[]) => SQLInputValue): void;
    function(
      name: string,
      options: FunctionOptions,
      func: (...args: SQLOutputValue[]) => SQLInputValue,
    ): void;
    readonly isOpen: boolean;
    readonly isTransaction: boolean;
    readonly limits: DatabaseSyncLimits;
    open(): void;
    prepare(sql: string, options?: StatementSyncOptions): StatementSync;
    createTagStore(maxSize?: number): SQLTagStore;
    createSession(options?: CreateSessionOptions): Session;
    applyChangeset(changeset: ScriptcBufferView, options?: ApplyChangesetOptions): boolean;
    serialize(dbName?: string): Uint8Array;
    deserialize(buffer: ScriptcBufferView, options?: { dbName?: string | undefined }): void;
    [Symbol.dispose](): void;
  }
  function backup(
    sourceDb: DatabaseSync,
    path: string | URL,
    options?: BackupOptions,
  ): Promise<number>;
  namespace constants {
    const SQLITE_CHANGESET_OMIT: number;
    const SQLITE_CHANGESET_REPLACE: number;
    const SQLITE_CHANGESET_ABORT: number;
    const SQLITE_CHANGESET_DATA: number;
    const SQLITE_CHANGESET_NOTFOUND: number;
    const SQLITE_CHANGESET_CONFLICT: number;
    const SQLITE_CHANGESET_CONSTRAINT: number;
    const SQLITE_CHANGESET_FOREIGN_KEY: number;
    const SQLITE_OK: number;
    const SQLITE_DENY: number;
    const SQLITE_IGNORE: number;
    const SQLITE_CREATE_INDEX: number;
    const SQLITE_CREATE_TABLE: number;
    const SQLITE_CREATE_TEMP_INDEX: number;
    const SQLITE_CREATE_TEMP_TABLE: number;
    const SQLITE_CREATE_TEMP_TRIGGER: number;
    const SQLITE_CREATE_TEMP_VIEW: number;
    const SQLITE_CREATE_TRIGGER: number;
    const SQLITE_CREATE_VIEW: number;
    const SQLITE_DELETE: number;
    const SQLITE_DROP_INDEX: number;
    const SQLITE_DROP_TABLE: number;
    const SQLITE_DROP_TEMP_INDEX: number;
    const SQLITE_DROP_TEMP_TABLE: number;
    const SQLITE_DROP_TEMP_TRIGGER: number;
    const SQLITE_DROP_TEMP_VIEW: number;
    const SQLITE_DROP_TRIGGER: number;
    const SQLITE_DROP_VIEW: number;
    const SQLITE_INSERT: number;
    const SQLITE_PRAGMA: number;
    const SQLITE_READ: number;
    const SQLITE_SELECT: number;
    const SQLITE_TRANSACTION: number;
    const SQLITE_UPDATE: number;
    const SQLITE_ATTACH: number;
    const SQLITE_DETACH: number;
    const SQLITE_ALTER_TABLE: number;
    const SQLITE_REINDEX: number;
    const SQLITE_ANALYZE: number;
    const SQLITE_CREATE_VTABLE: number;
    const SQLITE_DROP_VTABLE: number;
    const SQLITE_FUNCTION: number;
    const SQLITE_SAVEPOINT: number;
    const SQLITE_COPY: number;
    const SQLITE_RECURSIVE: number;
  }
  export {
    DatabaseSync,
    StatementSync,
    Session,
    SQLTagStore,
    StatementSyncIterator,
    DatabaseSyncLimits,
    SQLInputValue,
    SQLOutputValue,
    DatabaseSyncOptions,
    StatementSyncOptions,
    FunctionOptions,
    AggregateOptions,
    CreateSessionOptions,
    ApplyChangesetOptions,
    BackupOptions,
    BackupProgressInfo,
    StatementColumnMetadata,
    StatementResultingChanges,
    backup,
    constants,
  };
}
