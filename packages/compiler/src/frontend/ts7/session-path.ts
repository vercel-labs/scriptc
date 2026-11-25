/** TypeScript's protocol uses platform-independent path keys, including
 * bundled-library URLs and Windows paths on non-Windows clients. Do not
 * canonicalize these with the client's host-specific node:path rules. */
// Normalization follows typescript@7.1.0-beta's path helpers, Copyright Microsoft
// Corporation, licensed under Apache-2.0. Preserve the pinned key spelling.
/** The prefix of a virtual document's file name; `encodedRootLength` reads
 * its root from the scheme and authority segments. */
const DYNAMIC_URI_PREFIX = "^/~ts-uri~/";

function volume(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function encodedRootLength(path: string): number {
  if (path.length === 0) return 0;
  const first = path.charCodeAt(0);
  if (first === 47) {
    if (path.charCodeAt(1) !== 47) return 1;
    const slash = path.indexOf("/", 2);
    return slash < 0 ? path.length : slash + 1;
  }
  if (first === 94 && path.charCodeAt(1) === 47) {
    if (path.startsWith(DYNAMIC_URI_PREFIX)) {
      const schemeEnd = path.indexOf("/", DYNAMIC_URI_PREFIX.length);
      if (schemeEnd !== -1) {
        const authorityEnd = path.indexOf("/", schemeEnd + 1);
        if (authorityEnd !== -1) return authorityEnd + 1;
        return ~path.length;
      }
    }
    return 2;
  }
  if (volume(first) && path.charCodeAt(1) === 58) {
    if (path.charCodeAt(2) === 47) return 3;
    if (path.length === 2) return 2;
  }
  const schemeEnd = path.indexOf("://");
  if (schemeEnd < 0) return 0;
  const authorityStart = schemeEnd + 3;
  const authorityEnd = path.indexOf("/", authorityStart);
  if (authorityEnd < 0) return ~path.length;
  const authority = path.slice(authorityStart, authorityEnd);
  if (
    path.slice(0, schemeEnd) === "file" &&
    (authority === "" || authority === "localhost") &&
    volume(path.charCodeAt(authorityEnd + 1))
  ) {
    const start = authorityEnd + 2;
    const end =
      path.charCodeAt(start) === 58
        ? start + 1
        : path.slice(start, start + 3).toLowerCase() === "%3a"
          ? start + 3
          : -1;
    if (end >= 0) {
      if (path.charCodeAt(end) === 47) return ~(end + 1);
      if (end === path.length) return ~end;
    }
  }
  return ~(authorityEnd + 1);
}

function slashes(path: string): string {
  return path.split("\\").join("/");
}

const relativeSegments = /\/\/|(?:^|\/)\.\.?(?:$|\/)/;
const lowerCaseNeeded = /[^İıßa-z0-9\\/:\-_. ]/;
const lowerCaseRuns = /[^İıßa-z0-9\\/:\-_. ]+/g;

/** File names fold to lower case per code point, except U+0130, U+0131 and
 * U+00DF, which stay distinct on every platform. */
function fileNameLowerCase(text: string): string {
  if (!lowerCaseNeeded.test(text)) return text;
  return text.replace(lowerCaseRuns, (run) => {
    let result = "";
    for (const char of run) result += char.toLowerCase();
    return result;
  });
}

function simplePath(path: string): string | undefined {
  if (!relativeSegments.test(path)) return path;
  let simplified = path.replace(/\/\.\//g, "/");
  if (simplified.startsWith("./")) simplified = simplified.slice(2);
  if (simplified !== path && !relativeSegments.test(simplified)) return simplified;
  return undefined;
}

function withoutTrailing(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function normalizeAbsolute(path: string, rootLength: number): string {
  const simple = simplePath(path);
  if (simple !== undefined) return simple.length > rootLength ? withoutTrailing(simple) : simple;
  const root = path.slice(0, rootLength);
  let normalized = "";
  let initialized = false;
  let index = rootLength;
  let normalizedUpTo = index;
  let seenNonDotDot = rootLength !== 0;
  while (index < path.length) {
    let segmentStart = index;
    let code = path.charCodeAt(index);
    while (code === 47 && index + 1 < path.length) {
      code = path.charCodeAt(++index);
    }
    if (index > segmentStart) {
      if (!initialized) {
        normalized = path.slice(0, segmentStart - 1);
        initialized = true;
      }
      segmentStart = index;
    }
    let end = path.indexOf("/", index + 1);
    if (end < 0) end = path.length;
    const length = end - segmentStart;
    if (length === 1 && code === 46) {
      if (!initialized) {
        normalized = path.slice(0, normalizedUpTo);
        initialized = true;
      }
    } else if (length === 2 && code === 46 && path.charCodeAt(index + 1) === 46) {
      if (!seenNonDotDot) {
        if (initialized) normalized += normalized.length === rootLength ? ".." : "/..";
        else normalizedUpTo = index + 2;
      } else if (!initialized) {
        initialized = true;
        normalized =
          normalizedUpTo >= 2
            ? path.slice(0, Math.max(rootLength, path.lastIndexOf("/", normalizedUpTo - 2)))
            : path.slice(0, normalizedUpTo);
      } else {
        const slash = normalized.lastIndexOf("/");
        normalized = slash < 0 ? root : normalized.slice(0, Math.max(rootLength, slash));
        if (normalized.length === rootLength) seenNonDotDot = rootLength !== 0;
      }
    } else if (initialized) {
      if (normalized.length !== rootLength) normalized += "/";
      seenNonDotDot = true;
      normalized += path.slice(segmentStart, end);
    } else {
      seenNonDotDot = true;
      normalizedUpTo = end;
    }
    index = end + 1;
  }
  return initialized ? normalized : path.length > rootLength ? withoutTrailing(path) : path;
}

/** Canonical identity follows the server's case-sensitivity, independently
 * of the platform hosting the client. A path is normalized with file intent:
 * a root keeps its trailing separator and no deeper path holds one, whether
 * it was rooted or resolved against a working directory. */
export class Ts7Paths {
  constructor(
    readonly currentDirectory: string,
    readonly caseSensitive: boolean,
  ) {
    if (encodedRootLength(slashes(currentDirectory)) <= 0)
      throw new Error("TypeScript working directory must be an absolute disk path");
  }

  canonical(file: string): string {
    let path = slashes(file);
    let encoded = encodedRootLength(path);
    if (encoded === 0 && this.currentDirectory.length > 0) {
      const cwd = slashes(this.currentDirectory);
      path = cwd + (cwd.endsWith("/") || path.length === 0 ? "" : "/") + path;
      encoded = encodedRootLength(path);
    }
    const rootLength = encoded < 0 ? ~encoded : encoded;
    const result = normalizeAbsolute(path, rootLength);
    // A root keeps its trailing separator; every deeper path has file intent
    // and holds none.
    const rooted =
      result.length === rootLength && rootLength > 0 && !result.endsWith("/")
        ? result + "/"
        : result;
    // A virtual document's name is an identity in its own right: its encoded
    // segments never fold case.
    return this.caseSensitive || rooted.startsWith(DYNAMIC_URI_PREFIX)
      ? rooted
      : fileNameLowerCase(rooted);
  }
}

/** A virtual document's file name keeps the URI's own escaping, so that a
 * name converts back to the URI it came from. A segment that needs escaping
 * becomes `~ts-uri-escape~` and its UTF-8 bytes in hex, a URI with no path
 * `~ts-uri-no-path~` and its suffix. */
const DYNAMIC_URI_PATH_ESCAPE = "~ts-uri-escape~";
const DYNAMIC_URI_SPEC_ESCAPE = "~ts-uri-spec~";
const DYNAMIC_URI_NO_PATH_ESCAPE = "~ts-uri-no-path~";
const DYNAMIC_URI_NEEDS_ESCAPE = new RegExp(
  `(?:^|/)(?:\\.{1,2}(?:/|$)|${DYNAMIC_URI_PATH_ESCAPE}|${DYNAMIC_URI_SPEC_ESCAPE}|${DYNAMIC_URI_NO_PATH_ESCAPE})`,
);

/** The UTF-8 bytes of an encoded string as lower-case hex pairs. */
function hexBytes(encoded: string): string {
  let hex = "";
  for (let index = 0; index < encoded.length; index++) {
    if (encoded.charCodeAt(index) === 37) {
      hex += encoded.slice(index + 1, index + 3).toLowerCase();
      index += 2;
    } else hex += encoded.charCodeAt(index).toString(16).padStart(2, "0");
  }
  return hex;
}

/** A segment's extension, which an escape keeps outside the hex bytes so the
 * file name still ends in it. */
function extensionOf(segment: string): string {
  const baseStart = segment.lastIndexOf("\\") + 1;
  for (const extension of [".d.ts", ".d.mts", ".d.cts"])
    if (segment.endsWith(extension) && segment.length - extension.length >= baseStart)
      return extension;
  if (segment.endsWith(".ts")) {
    const declaration = segment.indexOf(".d.", baseStart);
    if (declaration >= 0) return segment.slice(declaration);
  }
  const dot = segment.lastIndexOf(".");
  return dot > segment.lastIndexOf("\\") ? segment.slice(dot) : "";
}

function splitExtension(segment: string): [base: string, extension: string] {
  const extension = extensionOf(segment);
  return extension === "" ? [segment, extension] : [segment.slice(0, -extension.length), extension];
}

function escapeSegment(segment: string, preserveExtension: boolean): string {
  let extension = "";
  if (preserveExtension && segment !== "." && segment !== "..")
    [segment, extension] = splitExtension(segment);
  return DYNAMIC_URI_PATH_ESCAPE + hexBytes(encodeURIComponent(segment)) + "~" + extension;
}

function segmentNeedsEscape(segment: string): boolean {
  return (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.startsWith(DYNAMIC_URI_PATH_ESCAPE) ||
    segment.startsWith(DYNAMIC_URI_SPEC_ESCAPE) ||
    segment.startsWith(DYNAMIC_URI_NO_PATH_ESCAPE) ||
    segment.includes("\\")
  );
}

function escapePathSegment(segment: string, preserveExtension: boolean): string {
  return segmentNeedsEscape(segment) ? escapeSegment(segment, preserveExtension) : segment;
}

function pathNeedsEscape(path: string): boolean {
  return (
    path === "" ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("//") ||
    path.includes("\\") ||
    DYNAMIC_URI_NEEDS_ESCAPE.test(path)
  );
}

function isRooted(path: string): boolean {
  return encodedRootLength(path) > 0;
}

function encodeDynamicPath(path: string, preserveFinalExtension = true): string {
  if (!pathNeedsEscape(path) && !isRooted(path)) return path;
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index++)
    segments[index] = escapePathSegment(
      segments[index]!,
      preserveFinalExtension && index === segments.length - 1,
    );
  if (isRooted(segments.join("/")))
    segments[0] = escapeSegment(segments[0]!, segments.length === 1 && preserveFinalExtension);
  return segments.join("/");
}

function encodeDynamicPathWithSuffix(path: string, suffix: string): string {
  if (suffix === "") return encodeDynamicPath(path);
  const slash = path.lastIndexOf("/");
  const before = slash < 0 ? "" : encodeDynamicPath(path.slice(0, slash), false) + "/";
  const [base, extension] = splitExtension(path.slice(slash + 1));
  return before + escapeSegment(base + "\0" + suffix, false) + extension;
}

function encodeNoPath(suffix: string): string {
  return DYNAMIC_URI_NO_PATH_ESCAPE + hexBytes(encodeURIComponent(suffix)) + "~";
}

/** Preserve TypeScript's URI spelling, including escaped virtual names.
 * Local file URLs decode their path; UNC URLs preserve escaped path bytes
 * just as the pinned SDK does. */
export function ts7DocumentFile(document: string | { uri: string }): string {
  if (typeof document === "string") return document;
  const uri = document.uri;
  if (uri.startsWith("bundled:///")) return uri;
  if (uri.startsWith("file://")) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new Error("invalid file URI: " + uri);
    }
    const path = decodeURIComponent(parsed.pathname);
    if (parsed.host !== "") return "//" + parsed.host + path;
    if (
      path.length >= 3 &&
      path.charCodeAt(0) === 47 &&
      volume(path.charCodeAt(1)) &&
      path.charCodeAt(2) === 58
    ) {
      return path.slice(1);
    }
    return path;
  }
  const colon = uri.indexOf(":");
  if (colon < 0) throw new Error("invalid URI: " + uri);
  const scheme = uri.slice(0, colon);
  let path = uri.slice(colon + 1);
  let suffix = "";
  const suffixStart = path.search(/[?#]/);
  if (suffixStart >= 0) {
    suffix = path.slice(suffixStart);
    path = path.slice(0, suffixStart);
  }
  let authority = "ts-nul-authority";
  let hasAuthority = false;
  let hasPath = true;
  if (path.startsWith("//")) {
    hasAuthority = true;
    const rest = path.slice(2);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      authority = rest;
      path = "";
      hasPath = false;
    } else {
      authority = rest.slice(0, slash);
      path = rest.slice(slash + 1);
    }
  }
  const encodedAuthority = hasAuthority
    ? authority === "ts-nul-authority"
      ? escapeSegment(authority, false)
      : encodeDynamicPath(authority)
    : authority;
  const encodedPath = hasPath ? encodeDynamicPathWithSuffix(path, suffix) : encodeNoPath(suffix);
  return DYNAMIC_URI_PREFIX + scheme + "/" + encodedAuthority + "/" + encodedPath;
}
/** tsgo's file identities use slashes on Windows. POSIX backslashes are
 * literal filename characters and must survive callback round trips. */
export function tsgoPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? path.replace(/\\/g, "/") : path;
}
