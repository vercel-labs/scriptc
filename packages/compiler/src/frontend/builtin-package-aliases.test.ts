import { expect, test } from "vitest";
import { builtinAliasOf, versionedPackageOfKey } from "./builtin-package-aliases.js";

test("aliases name the builtin each checked major's module is on Node 24", () => {
  expect(builtinAliasOf("isarray", "1.0.0", "")).toEqual({ whole: "Array.isArray" });
  expect(builtinAliasOf("isarray", "0.0.1", "index.js")).toEqual({ whole: "Array.isArray" });
  expect(builtinAliasOf("isarray", "3.0.0", "")).toBeNull();
  expect(builtinAliasOf("safe-buffer", "5.1.2", "")).toEqual({ whole: 'require("buffer")' });
  expect(builtinAliasOf("process-nextick-args", "2.0.1", "")).toEqual({ whole: "process" });
  expect(builtinAliasOf("process-nextick-args", "1.0.7", "")).toBeNull();
  expect(builtinAliasOf("inherits", "2.0.4", "inherits.js")).toEqual({
    whole: 'require("util").inherits',
  });
  // The browser file is the package's own implementation.
  expect(builtinAliasOf("inherits", "2.0.4", "inherits_browser.js")).toBeNull();
  expect(builtinAliasOf("util-deprecate", "1.0.2", "node.js")).toEqual({
    whole: 'require("util").deprecate',
  });
  expect(builtinAliasOf("util-deprecate", "1.0.2", "browser.js")).toBeNull();
});

test("readable-stream aliases follow each major's layout", () => {
  const rs2 = builtinAliasOf("readable-stream", "2.3.8", "readable.js");
  expect(rs2?.whole).toBe('require("stream").Readable');
  expect([...(rs2?.members?.names ?? [])].sort()).toEqual(
    ["Duplex", "PassThrough", "Readable", "Stream", "Transform", "Writable"].sort(),
  );
  expect(builtinAliasOf("readable-stream", "2.3.8", "writable.js")?.whole).toBe(
    'require("stream").Writable',
  );
  expect(builtinAliasOf("readable-stream", "2.3.8", "lib/_stream_duplex.js")?.whole).toBe(
    'require("stream").Duplex',
  );
  expect(builtinAliasOf("readable-stream", "2.3.8", "lib/internal/streams/destroy.js")).toBeNull();
  // 3.x has no root writable.js; its entry also carries finished and pipeline.
  const rs3 = builtinAliasOf("readable-stream", "3.6.2", "");
  expect(rs3?.whole).toBe('require("stream").Readable');
  expect([...(rs3?.members?.names ?? [])]).toContain("pipeline");
  expect(builtinAliasOf("readable-stream", "3.6.2", "lib/_stream_writable.js")?.whole).toBe(
    'require("stream").Writable',
  );
  expect(builtinAliasOf("readable-stream", "3.6.2", "writable.js")).toBeNull();
  expect(builtinAliasOf("readable-stream", "3.6.2", "lib/internal/streams/pipeline.js")).toBeNull();
  const rs4 = builtinAliasOf("readable-stream", "4.7.0", "lib/ours/index.js");
  expect(rs4?.whole).toBeNull();
  expect(rs4?.members?.names.has("pipeline")).toBe(true);
  expect(rs4?.members?.names.has("promises")).toBe(false);
  expect(builtinAliasOf("readable-stream", "4.7.0", "transform.js")).toBeNull();
  expect(builtinAliasOf("readable-stream", "4.7.0", "lib/_stream_transform.js")?.whole).toBe(
    'require("stream").Transform',
  );
});

test("pnpm module keys name the package, version and file", () => {
  expect(
    versionedPackageOfKey("../node_modules/.pnpm/isarray@1.0.0/node_modules/isarray/index.js"),
  ).toEqual({ name: "isarray", version: "1.0.0", subpath: "index.js" });
  expect(
    versionedPackageOfKey(
      "node_modules/.pnpm/@scope+pkg@2.1.0_peer@1.0.0/node_modules/@scope/pkg/lib/a.js",
    ),
  ).toEqual({ name: "@scope/pkg", version: "2.1.0", subpath: "lib/a.js" });
  // A store entry's own dependency links name other packages.
  expect(
    versionedPackageOfKey(
      "node_modules/.pnpm/from2@2.3.0/node_modules/readable-stream/readable.js",
    ),
  ).toBeNull();
  expect(versionedPackageOfKey("node_modules/isarray/index.js")).toBeNull();
});
