import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { withRlsOn } from "@/db";
import { householdMembers } from "@/db/schema";
import type { Actor } from "@/lib/authz";
import { type LedgerFixture, createLedgerFixture } from "@/modules/ledger/testing";

/**
 * Doar pentru testele familiei: fixture-ul registrului (A owner în HA, C member în HA, B owner în
 * HB) plus utilizatori noi fără gospodărie comună (`newUser`), adăugați direct ca membri de un
 * owner (`addMember`) sau prin invitații în teste. Nu se importă din codul aplicației.
 */
export type FamilyFixture = LedgerFixture &
  Readonly<{
    newUser: (name: string) => Promise<Actor>;
    addMember: (
      owner: Actor,
      householdId: string,
      user: Actor,
      role?: "member" | "owner",
    ) => Promise<void>;
  }>;

export async function createFamilyFixture(prefix: string): Promise<FamilyFixture> {
  const f = await createLedgerFixture(prefix);
  const newUser = async (name: string): Promise<Actor> => {
    const id = randomUUID();
    await f.db.execute(
      sql`insert into finet.users (id, email, name) values (${id}, ${`${name.toLowerCase()}-${id.slice(0, 8)}@exemplu.ro`}, ${name})`,
    );
    return { userId: id };
  };
  const addMember = async (
    owner: Actor,
    householdId: string,
    user: Actor,
    role: "member" | "owner" = "member",
  ) => {
    await withRlsOn(f.db, { userId: owner.userId, householdId }, (tx) =>
      tx.insert(householdMembers).values({ householdId, userId: user.userId, role }),
    );
  };
  return { ...f, newUser, addMember };
}
