/* The service's error hierarchy. Every error a handler can raise on purpose
 * derives from AppError and knows its HTTP status, a stable machine code and
 * optional structured details; the error handler renders them uniformly. */

export interface FieldIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 412 | 422 | 500;

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export abstract class AppError extends Error {
  abstract readonly status: ErrorStatus;
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }

  details(): Record<string, unknown> | undefined {
    return undefined;
  }

  toBody(): ErrorBody {
    const details = this.details();
    return details === undefined
      ? { error: { code: this.code, message: this.message } }
      : { error: { code: this.code, message: this.message, details } };
  }
}

export class ValidationError extends AppError {
  readonly status = 400;
  readonly code = "validation_failed";

  readonly target: string;
  readonly issues: readonly FieldIssue[];

  constructor(target: string, issues: readonly FieldIssue[]) {
    super(`Invalid ${target}: ${issues.length} issue${issues.length === 1 ? "" : "s"}`);
    this.target = target;
    this.issues = issues;
  }

  override details(): Record<string, unknown> {
    return { target: this.target, issues: this.issues };
  }
}

export class AuthenticationError extends AppError {
  readonly status = 401;
  readonly code = "unauthenticated";
}

export class ForbiddenError extends AppError {
  readonly status = 403;
  readonly code = "forbidden";

  readonly scope: string;

  constructor(scope: string) {
    super(`Missing scope: ${scope}`);
    this.scope = scope;
  }

  override details(): Record<string, unknown> {
    return { scope: this.scope };
  }
}

export class NotFoundError extends AppError {
  readonly status = 404;
  readonly code = "not_found";

  readonly entity: string;
  readonly id: string;

  constructor(entity: string, id: string) {
    super(`${entity} ${id} does not exist`);
    this.entity = entity;
    this.id = id;
  }

  override details(): Record<string, unknown> {
    return { entity: this.entity, id: this.id };
  }
}

export class ConflictError extends AppError {
  readonly status = 409;
  readonly code = "conflict";

  readonly field: string;
  readonly value: string;

  constructor(message: string, field: string, value: string) {
    super(message);
    this.field = field;
    this.value = value;
  }

  override details(): Record<string, unknown> {
    return { field: this.field, value: this.value };
  }
}

export class PreconditionFailedError extends AppError {
  readonly status = 412;
  readonly code = "precondition_failed";

  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`Version mismatch: expected ${expected}, found ${actual}`);
    this.expected = expected;
    this.actual = actual;
  }

  override details(): Record<string, unknown> {
    return { expected: this.expected, actual: this.actual };
  }
}

export type RuleViolation =
  | { readonly rule: "no_copies_available"; readonly bookId: string }
  | { readonly rule: "loan_limit_reached"; readonly memberId: string; readonly limit: number }
  | { readonly rule: "already_returned"; readonly loanId: string }
  | { readonly rule: "has_active_loans"; readonly count: number }
  | { readonly rule: "member_suspended"; readonly memberId: string };

export class BusinessRuleError extends AppError {
  readonly status = 422;
  readonly code = "rule_violated";

  readonly violation: RuleViolation;

  constructor(violation: RuleViolation) {
    super(describeViolation(violation));
    this.violation = violation;
  }

  override details(): Record<string, unknown> {
    return { ...this.violation };
  }
}

export function describeViolation(violation: RuleViolation): string {
  switch (violation.rule) {
    case "no_copies_available":
      return `No copies of ${violation.bookId} are available`;
    case "loan_limit_reached":
      return `Member ${violation.memberId} already holds ${violation.limit} loans`;
    case "already_returned":
      return `Loan ${violation.loanId} was already returned`;
    case "has_active_loans":
      return `The book still has ${violation.count} active loan${violation.count === 1 ? "" : "s"}`;
    case "member_suspended":
      return `Member ${violation.memberId} is suspended`;
  }
}
