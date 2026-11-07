/* Type claims, as `scriptc coverage` reports them.
 *
 * scriptc treats a declared type as a fact and checks it where an untyped
 * value enters typed code: a checked conversion that throws `TypeError:
 * expected X at $.path, got Y` when the value does not fit. A claim is a
 * conversion whose value is typed by something no build can verify: a
 * package's declarations (for a value a Node island or compiled package
 * code hands over), an assertion over parsed data, or the type a slot gives
 * an `any`. When the claim is wrong the build succeeds and the program
 * throws at that conversion the first time it runs.
 *
 * The report lists the claims before anything runs, grouped by what makes
 * the claim and ranked by how many conversions trust it, with what would
 * make the group safe:
 *
 * - in the program's own code, one group per package declaration, per
 *   untyped binding the values are read from, and per type parsed data is
 *   given;
 * - inside a package compiled from its JavaScript, one group per package:
 *   its conversions check the package against its own declarations and
 *   inferred types, and one decision (patch a declaration, or run the
 *   package in a Node island) covers them.
 *
 * The sites come from the lowering (frontend/lowering/type-claims.ts).
 * Imports nothing heavy, like dynamic-slots.ts. */
import type { SrcLoc } from "../ir/ir.js";

/** Where a claim's value comes from. */
export type TypeClaimKind =
  /** A Node island's value, typed by the island package's declarations. */
  | "island"
  /** A value typed by a package's declarations (.d.ts, @types or JSDoc)
   * where compiled code receives it. */
  | "declared"
  /** Data parsed at run time (`JSON.parse`), typed by the program. */
  | "parsed"
  /** A value read from a binding the source declares `any` or `unknown`,
   * or a dynamically held value the program gives a type by assertion. */
  | "untyped";

/** One checked conversion that trusts a claim. */
export interface TypeClaimSite {
  kind: TypeClaimKind;
  loc: SrcLoc;
  /** The type the conversion checks the value against. */
  claimed: string;
  /** The claiming declaration (lowering/decl-origin.ts's encoding). */
  origin?: string;
  /** The untyped binding the value is read from. */
  binding?: { name: string; loc: SrcLoc };
  /** The site is a function handed to a Node island: the island's calls
   * are checked against its parameter types. */
  callback?: true;
  /** The conversion is a type assertion's (`x as T`) over a value the
   * program holds dynamically; `binding` names what it is read from. */
  asserted?: true;
  /** The conversion is inside a `try` whose handler neither reads the
   * error nor throws: a failed claim leaves no trace there. */
  swallowed?: true;
  /** The origin is the declaration of the island value this one was
   * reached through (a member the lowering names no declaration for). */
  reached?: true;
  /** The package whose compiled file holds the site. */
  inPackage?: { name: string; version: string };
  /** The compiled package whose code produced the value. */
  from?: { name: string; version: string };
  /** A Node island's own object never converts to the claimed type (a
   * Date, a RegExp, a Node handle, a compiled class): the conversion
   * passes only for a value the program passed into the island. */
  nativeOnly?: true;
}

/** A claiming declaration. */
export interface TypeClaimDeclaration {
  package: string;
  version: string;
  /** The declaration's `scriptc types patch` selector; empty when it has
   * none (a generic declaration, whose type the program instantiates). */
  selector: string;
  /** The name the declaration is reported under. */
  name: string;
  /** `<file in the package>:<line>`. */
  at: string;
  declaredType: string;
}

/** What a group's claims are made by. */
export type TypeClaimGroupKind = TypeClaimKind | "package";

/** The claims that stand or fall together, with every conversion that
 * trusts them. */
export interface TypeClaimGroup {
  kind: TypeClaimGroupKind;
  /** `island` and `declared`: the claiming declaration. */
  declaration?: TypeClaimDeclaration;
  /** `untyped`: the binding the values are read from. */
  binding?: { name: string; loc: SrcLoc };
  /** `package`: the compiled package, and its declarations the
   * conversions trust, most trusted first. `declared` without a
   * declaration: the compiled package whose code produced the values. */
  package?: { name: string; version: string };
  declarations?: (TypeClaimDeclaration & { count: number })[];
  /** `island`: how many of the sites convert to a type no object of the
   * island's own converts to. They throw whenever they run, unless the
   * value is one the program passed into the island. */
  nativeOnly?: number;
  /** `island`: how many of the sites are functions the island calls. */
  callbacks?: number;
  /** `untyped`: how many of the sites are type assertions over a value
   * the program holds dynamically. */
  asserted?: number;
  /** `island`: how many of the sites convert a value reached through the
   * declared one (a member of it, the result of a call on it). */
  reached?: number;
  /** The sites inside a `try` whose handler neither reads the error nor
   * throws: there a failed claim is invisible, where Node keeps the value. */
  swallowed?: SrcLoc[];
  /** The types the conversions check for, most frequent first. */
  claimed: string[];
  sites: SrcLoc[];
  /** What would make the group safe. */
  fix: string;
}

const SEPARATOR = "\x1f";

/** The fields of an origin (decl-origin.ts): package, version, patch
 * range, selector, where, declared type. An empty range marks a
 * declaration that is named but has no selector to patch it by. */
function declarationOf(origin: string): TypeClaimDeclaration {
  const [pkg = "", version = "", range = "", selector = "", at = "", declared = ""] =
    origin.split(SEPARATOR);
  return {
    package: pkg,
    version,
    selector: range === "" ? "" : selector,
    name: selector,
    at,
    declaredType: declared,
  };
}

/** One argument of a suggested command, quoted for a POSIX shell. */
function shellArgument(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** True for a declaration typed `any` or `unknown`: what the conversion
 * checks is the type the program gave the value. */
function promisesNothing(d: TypeClaimDeclaration): boolean {
  return d.declaredType === "any" || d.declaredType === "unknown";
}

const WIDENS = "a type that starts with | widens the declared one, as in '| undefined'";

function fixOf(group: Omit<TypeClaimGroup, "fix">): string {
  const d = group.declaration;
  if (group.package !== undefined && group.kind === "declared") {
    const name = shellArgument(group.package.name);
    return (
      `check the value (typeof, in, a schema) before giving it this type; if the package's declarations are wrong, patch them ` +
      `(scriptc types patch ${name} <selector> '<type>'), or run the package in a Node island (--node-island=${name})`
    );
  }
  if (group.package !== undefined) {
    const name = shellArgument(group.package.name);
    return (
      `run the package in a Node island (--node-island=${name}), or patch the declaration that is wrong: ` +
      `scriptc types patch ${name} <selector> '<type>' (--print=diagnostics lists each declaration's selector)`
    );
  }
  if (d !== undefined && (group.nativeOnly ?? 0) > 0) {
    return (
      "a Node island's own object never converts to this type: keep the value as the island's by giving it a type the island package declares, " +
      "or read what the program needs from it through the island's own members"
    );
  }
  if (d !== undefined) {
    if (d.selector !== "" && promisesNothing(d)) {
      return (
        `the declaration promises nothing, the program's own type is what is checked: check the value (typeof, in, a schema) before giving it that type, ` +
        `or give the declaration the type it really has: scriptc types patch ${shellArgument(d.package)} ${shellArgument(d.selector)} '<type>'`
      );
    }
    if (d.selector !== "") {
      return (
        `if the declaration is wrong, patch it: scriptc types patch ${shellArgument(d.package)} ` +
        `${shellArgument(d.selector)} '<type>' (${WIDENS})`
      );
    }
    return (
      "no selector reaches this declaration (it is generic, or the member comes from a mapped or inferred type), so its type is the one this program gives it: " +
      "correct the type at the listed sites, or replace the declaration file with a " +
      `"files" type patch ("scriptc": { "typePatches": { "${d.package}@${d.version === "" ? "*" : `^${d.version}`}": { "files": … } } } in package.json)`
    );
  }
  if (group.kind === "island")
    return "check the island's value (typeof, in, a schema) before giving it this type, or declare the type it really has";
  if (group.kind === "parsed")
    return "validate the parsed data before giving it this type (a schema, or checks on an unknown value), or declare the type the data really has";
  if ((group.asserted ?? 0) > 0)
    return "check the value (typeof, in, a schema) before asserting its type, or build it under a declared type so the checker verifies it";
  return group.binding !== undefined
    ? `give '${group.binding.name}' the type its values really have where it is declared, or narrow the value (typeof, in, a schema) before typed code reads it`
    : "declare the value's real type, or narrow it (typeof, in, a schema) before typed code reads it";
}

const KIND_ORDER: readonly TypeClaimGroupKind[] = [
  "island",
  "declared",
  "package",
  "parsed",
  "untyped",
];

interface Pending {
  kind: TypeClaimGroupKind;
  declaration?: TypeClaimDeclaration;
  binding?: { name: string; loc: SrcLoc };
  package?: { name: string; version: string };
  declarations: Map<string, TypeClaimDeclaration & { count: number }>;
  callbacks: number;
  asserted: number;
  reached: number;
  nativeOnly: number;
  swallowed: SrcLoc[];
  claimed: Map<string, number>;
  sites: SrcLoc[];
  name: string;
}

/** The sites grouped by what makes their claim and ranked: first the
 * claims that throw whenever they run (an island's own object read as a
 * native-only type), then the claims with a conversion whose failure the
 * program would not see (inside a `try` that ignores the error), then the
 * claims in the program's code by reach, most conversions first (islands
 * before package declarations before the program's own, then by name),
 * then the packages compiled from their JavaScript, whose counts are of
 * their own files' conversions and measure something else. */
export function groupTypeClaims(sites: readonly TypeClaimSite[]): TypeClaimGroup[] {
  const groups = new Map<string, Pending>();
  for (const site of sites) {
    const declaration = site.origin === undefined ? undefined : declarationOf(site.origin);
    // Inside a compiled package, every conversion but an island crossing
    // checks the package against itself: one group per package.
    const inside = site.kind === "island" ? undefined : site.inPackage;
    // In the program's code, a value a compiled package's code produced.
    const produced = site.kind === "island" || declaration !== undefined ? undefined : site.from;
    let key: string;
    let name: string;
    if (inside !== undefined) {
      key = `p${SEPARATOR}${inside.name}${SEPARATOR}${inside.version}`;
      name = inside.name;
    } else if (declaration !== undefined) {
      // Two installed versions of a package are two declarations.
      key = `d${SEPARATOR}${site.kind}${SEPARATOR}${declaration.package}${SEPARATOR}${declaration.version}${SEPARATOR}${declaration.at}${SEPARATOR}${declaration.name}`;
      name = `${declaration.package} ${declaration.name}`;
    } else if (produced !== undefined) {
      key = `f${SEPARATOR}${produced.name}${SEPARATOR}${produced.version}`;
      name = produced.name;
    } else if (site.binding !== undefined) {
      key = `b${SEPARATOR}${site.kind}${site.asserted === true ? "!" : ""}${SEPARATOR}${site.binding.loc.file}${SEPARATOR}${site.binding.loc.start}${SEPARATOR}${site.binding.name}`;
      name = site.binding.name;
    } else {
      key = `t${SEPARATOR}${site.kind}${SEPARATOR}${site.claimed}`;
      name = site.claimed;
    }
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        kind: inside !== undefined ? "package" : produced !== undefined ? "declared" : site.kind,
        ...(inside !== undefined
          ? { package: inside }
          : declaration !== undefined
            ? { declaration }
            : produced !== undefined
              ? { package: produced }
              : site.binding !== undefined
                ? { binding: site.binding }
                : {}),
        declarations: new Map(),
        callbacks: 0,
        asserted: 0,
        reached: 0,
        nativeOnly: 0,
        swallowed: [],
        claimed: new Map(),
        sites: [],
        name,
      };
      groups.set(key, group);
    }
    if (inside !== undefined && declaration !== undefined) {
      const id = `${declaration.at}${SEPARATOR}${declaration.name}`;
      const known = group.declarations.get(id);
      if (known === undefined) group.declarations.set(id, { ...declaration, count: 1 });
      else known.count++;
    }
    if (site.callback === true) group.callbacks++;
    if (site.asserted === true) group.asserted++;
    if (site.reached === true) group.reached++;
    if (site.nativeOnly === true) group.nativeOnly++;
    if (site.swallowed === true) group.swallowed.push(site.loc);
    group.claimed.set(site.claimed, (group.claimed.get(site.claimed) ?? 0) + 1);
    group.sites.push(site.loc);
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        Number(b.nativeOnly > 0) - Number(a.nativeOnly > 0) ||
        Number(b.swallowed.length > 0) - Number(a.swallowed.length > 0) ||
        Number(a.kind === "package") - Number(b.kind === "package") ||
        b.sites.length - a.sites.length ||
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
    .map((g) => {
      const group: Omit<TypeClaimGroup, "fix"> = {
        kind: g.kind,
        ...(g.declaration !== undefined ? { declaration: g.declaration } : {}),
        ...(g.binding !== undefined ? { binding: g.binding } : {}),
        ...(g.package !== undefined
          ? {
              package: g.package,
              declarations: [...g.declarations.values()].sort(
                (a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
              ),
            }
          : {}),
        ...(g.callbacks > 0 ? { callbacks: g.callbacks } : {}),
        ...(g.asserted > 0 ? { asserted: g.asserted } : {}),
        ...(g.reached > 0 ? { reached: g.reached } : {}),
        ...(g.nativeOnly > 0 ? { nativeOnly: g.nativeOnly } : {}),
        ...(g.swallowed.length > 0 ? { swallowed: g.swallowed } : {}),
        claimed: [...g.claimed.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .map(([type]) => type),
        sites: g.sites,
      };
      return { ...group, fix: fixOf(group) };
    });
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** `debug@4.4.3 declares Debugger.enabled as boolean (index.d.ts:52)`, the
 * program's own claim (`'body' is untyped; its values are read as number`),
 * or a compiled package's total. */
export function typeClaimLabel(group: TypeClaimGroup): string {
  const claimed = group.claimed.slice(0, 3).join(", ") + (group.claimed.length > 3 ? ", …" : "");
  if (group.package !== undefined && group.kind === "declared") {
    const version = group.package.version === "" ? "" : `@${group.package.version}`;
    return `${group.package.name}${version}, compiled from its JavaScript, hands the program values it reads as ${claimed}`;
  }
  if (group.package !== undefined) {
    const declared = (group.declarations ?? []).reduce((n, d) => n + d.count, 0);
    const rest = group.sites.length - declared;
    const parts: string[] = [];
    if (declared > 0)
      parts.push(
        `${plural(declared, "conversion")} trust${declared === 1 ? "s" : ""} ${plural(group.declarations!.length, "declaration")} of its own`,
      );
    if (rest > 0) parts.push(`${plural(rest, "conversion")} of untyped values`);
    const version = group.package.version === "" ? "" : `@${group.package.version}`;
    return `${group.package.name}${version}, compiled from its JavaScript: ${parts.join(", ")}`;
  }
  const d = group.declaration;
  if (d !== undefined) {
    const head = `${d.package}${d.version === "" ? "" : `@${d.version}`} declares ${d.name}`;
    if (group.callbacks === group.sites.length)
      return `${head} (${d.at}): the Node island calls a function the program passes it, typed ${claimed}`;
    const declared = d.declaredType === "" ? "" : ` as ${d.declaredType}`;
    const value = group.kind === "island" ? "a Node island value" : "a package value";
    if ((group.nativeOnly ?? 0) > 0)
      return `${head}${declared} (${d.at}): ${value} the program reads as ${claimed}, which throws for every object the island made`;
    if (promisesNothing(d))
      return `${head}${declared} (${d.at}): ${value} the program reads as ${claimed}`;
    return (group.reached ?? 0) > 0
      ? `${head}${declared} (${d.at}): ${value}, and values reached through it read as ${claimed}`
      : `${head}${declared} (${d.at}): ${value}`;
  }
  if (group.kind === "island") return `a Node island value the program reads as ${claimed}`;
  if (group.kind === "parsed")
    return group.binding !== undefined
      ? `parsed data held in '${group.binding.name}', read as ${claimed}`
      : `parsed data the program reads as ${claimed}`;
  if ((group.asserted ?? 0) > 0)
    return group.binding !== undefined
      ? `the program asserts the type of '${group.binding.name}', a value it holds dynamically: ${claimed}`
      : `the program asserts the type of a value it holds dynamically: ${claimed}`;
  if (group.binding !== undefined)
    return `'${group.binding.name}' is untyped; its values are read as ${claimed}`;
  return `an untyped value read as ${claimed}`;
}
