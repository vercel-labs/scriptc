import { expect, test } from "vitest";
import type { CcOptions } from "./contracts.js";
import { resolveCc } from "./driver.js";
import { runtimeUnitArgs, type RuntimeUnitContext } from "./executable.js";

/** The source build's unit context for `opts`, with no optional facts or
 * vendored archives: the tests below select single features. */
function context(opts: Partial<CcOptions>): RuntimeUnitContext {
  return {
    opts: { cPath: "program.c", outPath: "program", ...opts },
    driver: resolveCc({}, "linux"),
    rt: (path) => path,
    rtDir: "/runtime",
    regex: false,
    nativeFetch: false,
    net: false,
    http: false,
    tls: false,
    tlsCa: false,
    cipher: false,
    ecdh: false,
    dh: false,
    argon2: false,
    pki: false,
    lreObjects: [],
    zlibObjects: [],
    zstdObjects: [],
    tlsArchive: null,
    mlkemArchive: null,
    brotliArchive: null,
    sqliteArchive: null,
    icuArchive: null,
    icuIncludeDirs: [],
  };
}

const source = (opts: Partial<CcOptions>): string[] =>
  runtimeUnitArgs(context(opts)).map((path) => path.slice("/runtime/".length));

test("node:module's Module class links the handle-class unit its value installs", () => {
  // scr_module_class.c installs the Module class through
  // scr_dyn_handle_class_install and builds its prototype through
  // scr_dyn_handle_class_prototype, both defined in scr_dyn_handle_class.c.
  // That unit's gate names every unit that calls it (web streams, the DNS
  // resolvers, and the Module class), as runtime-pack-matrix.mjs does for
  // the packs; leaving the class out breaks the link of a source build.
  expect(source({ moduleClass: true })).toEqual(["scr_module_class.c", "scr_dyn_handle_class.c"]);
  // The unit keeps its other two gates and links nothing else: the DNS
  // resolvers settle their promises through the checked-dynamic async unit.
  // A web-streams program links the stream unit beside it: the pair
  // adaptation the web unit's hook answers with lives there, and a macOS
  // link fails an undefined weak reference to it where the other formats read
  // it as 0 and left the hook empty.
  expect(source({ webStreams: true })).toEqual([
    "scr_webstreams.c",
    "scr_dyn_handle_class.c",
    "scr_stream.c",
    "scr_fs_stream.c",
    "scr_stream_defaults.c",
  ]);
  expect(source({ webStreams: true, dynAsync: true })).toEqual([
    "scr_async_dyn.c",
    "scr_perf.c",
    "scr_blob.c",
    "scr_webstreams.c",
    "scr_dyn_handle_class.c",
    "scr_stream.c",
    "scr_fs_stream.c",
    "scr_stream_defaults.c",
    "scr_stream_duplex_from_web.c",
    "scr_stream_from_web_writable.c",
  ]);
  expect(source({ dnsResolve: true })).toEqual(["scr_async_dyn.c", "scr_dyn_handle_class.c"]);
});
