// Helpers from undici's lib/core/util.js.
import { InvalidArgumentError } from "./errors.ts";
import type { IncomingHttpHeaders, Profile } from "./types.ts";

/** util.parseHeaders over raw [name, value, ...] pairs: lower-cased names,
 * repeated names collected into arrays. 5.x decodes values as UTF-8 and
 * treats an empty first value as absent; 7.x decodes latin1. */
export function parseHeaders(raw: readonly string[], profile: Profile): IncomingHttpHeaders {
  const obj: IncomingHttpHeaders = {};
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const key = raw[i]!.toLowerCase();
    const value = raw[i + 1]!;
    const existing = obj[key];
    const absent = profile.major >= 7 ? existing === undefined : !existing;
    if (absent) {
      obj[key] = value;
    } else if (typeof existing === "string") {
      obj[key] = [existing, value];
    } else if (existing !== undefined) {
      existing.push(value);
    }
  }
  return obj;
}

/** Raw header Buffers as strings (latin1 on 7.x, UTF-8 on 5.x). */
export function rawHeaderStrings(raw: readonly Buffer[], profile: Profile): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    // Names are ASCII tokens; values follow the version's decoding.
    out.push(
      i % 2 === 0 || profile.major >= 7 ? raw[i]!.toString("latin1") : raw[i]!.toString("utf8"),
    );
  }
  return out;
}

/** util.parseOrigin: an http(s) origin URL. */
export function parseOrigin(url: string | URL, profile: Profile): URL {
  const parsed = parseURL(url, profile);
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new InvalidArgumentError("invalid url");
  }
  return parsed;
}

/** util.parseURL for the string/URL forms. */
export function parseURL(url: string | URL, profile: Profile): URL {
  const parsed = typeof url === "string" ? new URL(url) : url;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // 7.x checks only string inputs; 5.x checks every input.
    if (profile.major < 7) throw new InvalidArgumentError("invalid protocol");
    if (typeof url === "string") {
      throw new InvalidArgumentError(
        "Invalid URL protocol: the URL must start with `http:` or `https:`.",
      );
    }
  }
  return parsed;
}

/** util.parseKeepAliveTimeout: the server's Keep-Alive `timeout=<s>` hint in
 * milliseconds, or null. */
export function parseKeepAliveTimeout(value: string): number | null {
  const m = /timeout=(\d+)/.exec(value);
  return m !== null ? parseInt(m[1]!, 10) * 1000 : null;
}
