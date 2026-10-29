import { z } from "zod";

import { idSchema } from "@/modules/ledger/input";

/** Intrările potrivirii bon ↔ tranzacție (Zod strict; ADR 0019). Fără dependențe de server. */

export const matchDecisionSchema = z.strictObject({
  transactionId: idSchema,
  decision: z.enum(["confirm", "reject"]),
});

export const matchQueueSchema = z.strictObject({
  limit: z.number().int().min(1).max(50).default(20),
});
