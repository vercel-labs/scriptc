// Generated from typescript@7.1.0-beta, with response shapes from typescript@7.0.2, by scripts/generate-ts7-ast-schema.mjs.
// TypeScript is Copyright Microsoft Corporation, licensed under Apache-2.0.
// Regenerate when changing the TypeScript pin; do not edit by hand.

export interface Ts7CompilerOptionsData {
    allowJs?: boolean;
    allowArbitraryExtensions?: boolean;
    allowImportingTsExtensions?: boolean;
    allowNonTsExtensions?: boolean;
    allowUmdGlobalAccess?: boolean;
    allowUnreachableCode?: boolean;
    allowUnusedLabels?: boolean;
    assumeChangesOnlyAffectDirectDependencies?: boolean;
    checkJs?: boolean;
    customConditions?: string[];
    composite?: boolean;
    emitDeclarationOnly?: boolean;
    emitBOM?: boolean;
    emitDecoratorMetadata?: boolean;
    declaration?: boolean;
    declarationDir?: string;
    declarationMap?: boolean;
    deduplicatePackages?: boolean;
    disableSizeLimit?: boolean;
    disableSourceOfProjectReferenceRedirect?: boolean;
    disableSolutionSearching?: boolean;
    disableReferencedProjectLoad?: boolean;
    erasableSyntaxOnly?: boolean;
    exactOptionalPropertyTypes?: boolean;
    experimentalDecorators?: boolean;
    forceConsistentCasingInFileNames?: boolean;
    isolatedModules?: boolean;
    isolatedDeclarations?: boolean;
    ignoreConfig?: boolean;
    ignoreDeprecations?: string;
    importHelpers?: boolean;
    inlineSourceMap?: boolean;
    inlineSources?: boolean;
    init?: boolean;
    incremental?: boolean;
    jsx?: number;
    jsxFactory?: string;
    jsxFragmentFactory?: string;
    jsxImportSource?: string;
    lib?: string[];
    libReplacement?: boolean;
    locale?: string;
    mapRoot?: string;
    module?: number;
    moduleResolution?: number;
    moduleSuffixes?: string[];
    moduleDetection?: number;
    newLine?: number;
    noEmit?: boolean;
    noCheck?: boolean;
    noErrorTruncation?: boolean;
    noFallthroughCasesInSwitch?: boolean;
    noImplicitAny?: boolean;
    noImplicitThis?: boolean;
    noImplicitReturns?: boolean;
    noEmitHelpers?: boolean;
    noLib?: boolean;
    noPropertyAccessFromIndexSignature?: boolean;
    noUncheckedIndexedAccess?: boolean;
    noEmitOnError?: boolean;
    noUnusedLocals?: boolean;
    noUnusedParameters?: boolean;
    noResolve?: boolean;
    noImplicitOverride?: boolean;
    noUncheckedSideEffectImports?: boolean;
    outDir?: string;
    paths?: Record<string, string[]>;
    preserveConstEnums?: boolean;
    preserveSymlinks?: boolean;
    project?: string;
    resolveJsonModule?: boolean;
    resolvePackageJsonExports?: boolean;
    resolvePackageJsonImports?: boolean;
    removeComments?: boolean;
    rewriteRelativeImportExtensions?: boolean;
    reactNamespace?: string;
    rootDir?: string;
    rootDirs?: string[];
    skipLibCheck?: boolean;
    stableTypeOrdering?: boolean;
    strict?: boolean;
    strictBindCallApply?: boolean;
    strictBuiltinIteratorReturn?: boolean;
    strictFunctionTypes?: boolean;
    strictNullChecks?: boolean;
    strictPropertyInitialization?: boolean;
    stripInternal?: boolean;
    skipDefaultLibCheck?: boolean;
    sourceMap?: boolean;
    sourceRoot?: string;
    suppressOutputPathCheck?: boolean;
    target?: number;
    traceResolution?: boolean;
    tsBuildInfoFile?: string;
    typeRoots?: string[];
    types?: string[];
    useDefineForClassFields?: boolean;
    useUnknownInCatchVariables?: boolean;
    verbatimModuleSyntax?: boolean;
    maxNodeModuleJsDepth?: number;
}

export interface Ts7InitializeData {
    /** Whether the host file system is case-sensitive */
    useCaseSensitiveFileNames: boolean;
    /** The server's current working directory */
    currentDirectory: string;
}

export interface Ts7ConfigData {
    options: Record<string, unknown>;
    fileNames: string[];
}

export interface Ts7SnapshotData {
    /** Handle for the newly created snapshot */
    snapshot: number;
    /** List of projects in the snapshot */
    projects: Ts7ProjectData[];
    /** Changes from the previous snapshot (absent for the first snapshot) */
    changes?: Ts7SnapshotChangeData;
}

export interface Ts7ProjectData {
    id: string;
    configFileName: string;
    compilerOptions: Ts7CompilerOptionsData;
    rootFiles: string[];
}

export interface Ts7SourceMetadata {
    isDefaultLibrary: boolean;
    isFromExternalLibrary: boolean;
    packageJsonType: string;
    packageJsonDirectory: string;
    impliedNodeFormat: number;
}

export interface Ts7SnapshotChangeData {
    /** Project handles mapped to their file changes. Projects not listed are unchanged. */
    changedProjects?: Record<string, Ts7ProjectChangeData>;
    /** Project handles that were removed from the snapshot */
    removedProjects?: string[];
}

export interface Ts7ProjectChangeData {
    /** Source file paths whose content changed */
    changedFiles?: string[];
    /** Source file paths removed from the project's program */
    deletedFiles?: string[];
}

export interface Ts7DiagnosticData {
    /** File name of the source file this diagnostic belongs to, if any */
    readonly fileName?: string | undefined;
    /** Start position of the diagnostic */
    readonly pos: number;
    /** End position of the diagnostic */
    readonly end: number;
    /** Diagnostic error code */
    readonly code: number;
    /** Diagnostic category (error, warning, suggestion, message) */
    readonly category: number;
    /** Localized diagnostic message text */
    readonly text: string;
    /** Whether this diagnostic highlights unnecessary code */
    readonly reportsUnnecessary?: boolean | undefined;
    /** Whether this diagnostic highlights deprecated code */
    readonly reportsDeprecated?: boolean | undefined;
    /** Chained diagnostic messages */
    readonly messageChain?: readonly Ts7DiagnosticData[] | undefined;
    /** Related diagnostic information */
    readonly relatedInformation?: readonly Ts7DiagnosticData[] | undefined;
}
