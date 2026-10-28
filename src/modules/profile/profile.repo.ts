import "server-only";

import { and, eq } from "drizzle-orm";

import type { Tx } from "@/db";
import { households, householdMembers, userPreferences, users } from "@/db/schema";

/** Profilul: `users` (fără RLS, filtrat pe id) și `user_preferences` (RLS pe utilizator). */

export async function selectProfile(tx: Tx, userId: string) {
  const rows = await tx
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      emailVerified: users.emailVerified,
      isPlatformAdmin: users.isPlatformAdmin,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function selectPreferences(tx: Tx, userId: string) {
  const rows = await tx
    .select({
      locale: userPreferences.locale,
      timezone: userPreferences.timezone,
      defaultCurrency: userPreferences.defaultCurrency,
      theme: userPreferences.theme,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function selectHousehold(tx: Tx, userId: string, householdId: string) {
  const rows = await tx
    .select({
      id: households.id,
      name: households.name,
      defaultCurrency: households.defaultCurrency,
      timezone: households.timezone,
      role: householdMembers.role,
    })
    .from(households)
    .innerJoin(householdMembers, eq(householdMembers.householdId, households.id))
    .where(and(eq(households.id, householdId), eq(householdMembers.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateUserName(tx: Tx, userId: string, name: string): Promise<void> {
  await tx.update(users).set({ name }).where(eq(users.id, userId));
}

export async function upsertPreferences(
  tx: Tx,
  userId: string,
  patch: Partial<typeof userPreferences.$inferInsert>,
): Promise<void> {
  await tx
    .insert(userPreferences)
    .values({ userId, ...patch })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { ...patch, updatedAt: new Date() },
    });
}
