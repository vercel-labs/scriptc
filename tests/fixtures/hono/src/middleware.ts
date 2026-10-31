/* The middleware stack: response timing, bearer authentication with
 * scopes, request validation and the uniform error renderer. */

import type { Context, ErrorHandler, MiddlewareHandler, NotFoundHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { AppError, AuthenticationError, ForbiddenError, ValidationError, type ErrorBody, type FieldIssue } from "./errors.ts";

export type Scope = "catalogue:write" | "members:write" | "loans:write" | "admin";

export interface Principal {
  readonly subject: string;
  readonly scopes: ReadonlySet<Scope>;
}

export interface AppEnv {
  Variables: {
    principal: Principal | null;
    requestId: string;
  };
}

/** Adds `X-Response-Time` with the handler's wall time in milliseconds. */
export function responseTime(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = performance.now();
    await next();
    const elapsed = performance.now() - started;
    c.res.headers.set("X-Response-Time", `${elapsed.toFixed(3)}ms`);
  };
}

/** Assigns a monotonically increasing request id, echoed as `X-Request-Id`
 * unless the caller supplied one. */
export function requestId(): MiddlewareHandler<AppEnv> {
  let counter = 0;
  return async (c, next) => {
    const supplied = c.req.header("x-request-id");
    const id = supplied !== undefined && /^[\w.-]{1,64}$/.test(supplied) ? supplied : `req-${(++counter).toString(36).padStart(6, "0")}`;
    c.set("requestId", id);
    await next();
    c.header("X-Request-Id", id);
  };
}

export class TokenRegistry {
  private readonly tokens = new Map<string, Principal>();

  register(token: string, subject: string, scopes: readonly Scope[]): this {
    this.tokens.set(token, { subject, scopes: new Set(scopes) });
    return this;
  }

  resolve(token: string): Principal | undefined {
    return this.tokens.get(token);
  }
}

/** Resolves an optional bearer token into the request's principal. A
 * malformed or unknown token is rejected even on public routes. */
export function authenticate(registry: TokenRegistry) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("authorization");
    if (header === undefined) {
      c.set("principal", null);
      return next();
    }
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
    if (match === null) throw new AuthenticationError("Authorization header must use the Bearer scheme");
    const principal = registry.resolve(match[1]!);
    if (principal === undefined) throw new AuthenticationError("Unknown bearer token");
    c.set("principal", principal);
    await next();
  });
}

/** Requires an authenticated principal holding `scope`. */
export function requireScope(scope: Scope) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const principal = c.get("principal");
    if (principal === null) throw new AuthenticationError("This operation requires a bearer token");
    if (!principal.scopes.has(scope) && !principal.scopes.has("admin")) throw new ForbiddenError(scope);
    await next();
  });
}

export function toIssues(error: z.core.$ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.map((part) => String(part)).join("."),
    code: issue.code,
    message: issue.message,
  }));
}

/** The zod-validator hook: turn a failed parse into a ValidationError. */
export function rejectInvalid(result: { success: boolean; error?: unknown; target: string }): void {
  if (!result.success) throw new ValidationError(result.target, toIssues(result.error as z.core.$ZodError));
}

function render(c: Context<AppEnv>, status: number, body: ErrorBody, headers?: Record<string, string>): Response {
  const response = c.json({ ...body, requestId: c.get("requestId") ?? null }, status as 400);
  if (headers !== undefined) for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

export const onError: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof AppError) {
    const headers: Record<string, string> | undefined =
      err instanceof AuthenticationError ? { "WWW-Authenticate": 'Bearer realm="library"' } : undefined;
    return render(c, err.status, err.toBody(), headers);
  }
  if (err instanceof HTTPException) {
    const code = err.status === 400 ? "bad_request" : err.status === 401 ? "unauthenticated" : "http_error";
    return render(c, err.status, { error: { code, message: err.message || "Request failed" } });
  }
  if (err instanceof SyntaxError) {
    return render(c, 400, { error: { code: "malformed_json", message: "Request body is not valid JSON" } });
  }
  return render(c, 500, { error: { code: "internal", message: "Internal server error" } });
};

export const notFound: NotFoundHandler<AppEnv> = (c) =>
  render(c, 404, { error: { code: "no_route", message: `No route for ${c.req.method} ${c.req.path}` } });
