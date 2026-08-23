import tseslint from "typescript-eslint";

/* The 5.9.3 parser islands: the ONLY files that may import typescript5
 * (the alias pinning the old compiler). Everything else lives in the
 * 7.0.2 world — the two worlds' enums are renumbered and their nodes are
 * not interchangeable, so a stray cross-import is a correctness bug, not
 * a style problem. */
const TS5_ISLANDS = [
  "packages/compiler/src/frontend/npm.ts",
  "packages/compiler/src/frontend/cjs-lexer.ts",
  "packages/compiler/src/frontend/lowering/lower-comptime.ts",
  "packages/compiler/src/frontend/ts7/world-check.ts",
  // The provenance prescan parses files BEFORE any program world exists
  // (the bare-import walk that decides what to fetch) — a parser island
  // exactly like npm.ts's specifier scan.
  "packages/compiler/src/frontend/provenance.ts",
  // The bundler-emitted-CJS export rewrite runs inside the fs shadow,
  // BEFORE the 7.0.2 program reads the file — a text→text parser island
  // beside cjs-lexer.ts (only strings cross its boundary).
  "packages/compiler/src/frontend/npm-static-rewrite.ts",
  // Semantic cache validation parses source text only to identify exact
  // regex spans and syntax errors; its boundary is strings, offsets, and
  // booleans, so no 5.9.3 AST value enters the 7.0.2 program world.
  "packages/compiler/src/library/semantic-source.ts",
];

const ts5Fence = {
  group: ["typescript5", "typescript5/*"],
  message: "typescript5 (the 5.9.3 island alias) is only for the explicit parser islands — everything else is the 7.0.2 world; the worlds never mix",
};
const frontendFence = {
  group: ["**/frontend/*", "**/frontend/**"],
  message: "backend must not import frontend — the IR is the only interface",
};
const backendFence = {
  group: ["**/backend/*", "**/backend/**"],
  message: "frontend must not import backend — the IR is the only interface",
};

/* NOTE: no-restricted-imports does not MERGE across matching config
 * blocks — the last matching block replaces the whole rule config. Every
 * block below therefore carries its complete pattern set. */
export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },
  {
    // The IR is the only interface between frontend and backend.
    files: ["packages/compiler/src/backend/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [frontendFence, ts5Fence] }],
    },
  },
  {
    files: ["packages/compiler/src/frontend/**"],
    ignores: TS5_ISLANDS,
    rules: {
      "no-restricted-imports": ["error", { patterns: [backendFence, ts5Fence] }],
    },
  },
  {
    files: TS5_ISLANDS,
    rules: {
      "no-restricted-imports": ["error", { patterns: [backendFence] }],
    },
  },
  {
    // Everything in the compiler outside frontend/backend (ir, diagnostics,
    // index) is 7.0.2-world too.
    files: ["packages/compiler/src/**"],
    ignores: [
      "packages/compiler/src/frontend/**",
      "packages/compiler/src/backend/**",
      ...TS5_ISLANDS,
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: [ts5Fence] }],
    },
  },
);
