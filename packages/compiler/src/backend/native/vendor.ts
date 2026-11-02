import { createVendorArchives } from "../vendor-archives.js";
import { runtimeSrcDir, runtimeFingerprint } from "./runtime-inputs.js";
import { targetPlatform, isZigDriver } from "./driver.js";
import { resolvedToolIdentity } from "./tool-identity.js";

export const {
  vendorEngineDir,
  vendorTlsDir,
  vendorBrotliDir,
  brotliArchivePath,
  ensureBrotliArchive,
  ensureIcuSources,
  icuArchivePath,
  ensureIcuArchive,
  vendorBuildCacheRoot,
  vendorCacheTargetFlavor,
  vendorCacheBuildIdentity,
  currentVendorCacheBuildIdentity,
  stageVendorInputs,
  lreObjectPaths,
  ensureLreObjects,
  vendorZlibDir,
  zlibObjectPaths,
  ensureZlibObjects,
  vendorZstdDir,
  zstdObjectPaths,
  ensureZstdObjects,
  tlsArchivePath,
  ensureTlsArchive,
  LRE_SOURCES,
  ZLIB_SOURCES,
  ZSTD_SOURCES,
} = createVendorArchives({
  runtimeSrcDir,
  targetPlatform,
  isZigDriver,
  resolvedToolIdentity,
  runtimeFingerprint,
});
