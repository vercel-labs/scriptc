/* Membership and lending routes. */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { Loan } from "../domain.ts";
import { rejectInvalid, requireScope, type AppEnv } from "../middleware.ts";
import { idParamSchema, loanCloseSchema, loanRequestSchema, memberDraftSchema, memberLoansQuerySchema } from "../schemas.ts";
import type { LibraryService } from "../service.ts";

function loanView(loan: Loan) {
  const { state } = loan;
  switch (state.kind) {
    case "active":
      return { ...loan, status: "active", dueAt: state.dueAt };
    case "returned":
      return { ...loan, status: state.lateDays > 0 ? "returned-late" : "returned", dueAt: null };
    case "lost":
      return { ...loan, status: "lost", dueAt: null };
  }
}

export function memberRoutes(service: LibraryService) {
  const routes = new Hono<AppEnv>();

  routes.post("/", requireScope("members:write"), zValidator("json", memberDraftSchema, rejectInvalid), async (c) => {
    const member = await service.createMember(c.req.valid("json"));
    c.header("Location", `/v1/members/${member.id}`);
    return c.json(member, 201);
  });

  routes.get("/:id", zValidator("param", idParamSchema, rejectInvalid), async (c) => {
    const member = service.members.require(c.req.valid("param").id);
    const active = service.memberLoans(member.id, "active").length;
    return c.json({ ...member, activeLoans: active });
  });

  routes.get(
    "/:id/loans",
    zValidator("param", idParamSchema, rejectInvalid),
    zValidator("query", memberLoansQuerySchema, rejectInvalid),
    async (c) => {
      const loans = service.memberLoans(c.req.valid("param").id, c.req.valid("query").state);
      return c.json({ items: loans.map(loanView), total: loans.length });
    },
  );

  routes.post("/:id/suspend", requireScope("admin"), zValidator("param", idParamSchema, rejectInvalid), async (c) => {
    return c.json(await service.suspend(c.req.valid("param").id, true));
  });

  routes.post("/:id/reinstate", requireScope("admin"), zValidator("param", idParamSchema, rejectInvalid), async (c) => {
    return c.json(await service.suspend(c.req.valid("param").id, false));
  });

  return routes;
}

export function loanRoutes(service: LibraryService) {
  const routes = new Hono<AppEnv>();

  routes.post("/quote", zValidator("json", loanRequestSchema, rejectInvalid), async (c) => {
    const { bookId, memberId, days } = c.req.valid("json");
    return c.json(service.quote(bookId, memberId, days));
  });

  routes.post("/", requireScope("loans:write"), zValidator("json", loanRequestSchema, rejectInvalid), async (c) => {
    const { bookId, memberId, days } = c.req.valid("json");
    const loan = await service.openLoan(bookId, memberId, days);
    c.header("Location", `/v1/loans/${loan.id}`);
    return c.json(loanView(loan), 201);
  });

  routes.get("/:id", zValidator("param", idParamSchema, rejectInvalid), (c) => {
    return c.json(loanView(service.loans.require(c.req.valid("param").id)));
  });

  routes.post(
    "/:id/close",
    requireScope("loans:write"),
    zValidator("param", idParamSchema, rejectInvalid),
    zValidator("json", loanCloseSchema, rejectInvalid),
    async (c) => {
      const loan = await service.closeLoan(c.req.valid("param").id, c.req.valid("json").outcome);
      return c.json(loanView(loan));
    },
  );

  return routes;
}
