import "server-only";

import { type Db, withRlsOn } from "@/db";
import { NotFoundError } from "@/lib/authz";
import { currentHouseholdIdOf } from "@/modules/auth/audit";
import { DEFAULT_PREFERENCES } from "@/modules/auth/users.repo";

import type { ProfilePatch } from "./profile.schema";
import {
  selectHousehold,
  selectPreferences,
  selectProfile,
  updateUserName,
  upsertPreferences,
} from "./profile.repo";

/**
 * Profilul utilizatorului curent (`GET/PATCH /api/v1/me`). `userId` vine din sesiune; gospodăria
 * curentă din BAZĂ (cea mai veche apartenență, ADR 0003), niciodată din cerere. Toate citirile
 * rulează în contextul RLS al utilizatorului (și al gospodăriei curente).
 */

export type Me = Readonly<{
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    isPlatformAdmin: boolean;
    createdAt: string;
  };
  preferences: { locale: string; timezone: string; defaultCurrency: string; theme: string };
  household: {
    id: string;
    name: string;
    defaultCurrency: string;
    timezone: string;
    role: "owner" | "member";
  } | null;
}>;

export async function getMe(db: Db, userId: string): Promise<Me> {
  return withRlsOn(db, { userId }, async (tx) => {
    const profile = await selectProfile(tx, userId);
    if (!profile) throw new NotFoundError();
    const preferences = (await selectPreferences(tx, userId)) ?? {
      ...DEFAULT_PREFERENCES,
      theme: "system" as const,
    };
    const householdId = await currentHouseholdIdOf(tx, userId);
    const household = householdId ? await selectHousehold(tx, userId, householdId) : null;
    return {
      user: { ...profile, createdAt: profile.createdAt.toISOString() },
      preferences,
      household,
    };
  });
}

export async function updateMe(db: Db, userId: string, patch: ProfilePatch): Promise<Me> {
  await withRlsOn(db, { userId }, async (tx) => {
    if (patch.name !== undefined) await updateUserName(tx, userId, patch.name);
    if (patch.preferences && Object.keys(patch.preferences).length > 0) {
      await upsertPreferences(tx, userId, patch.preferences);
    }
  });
  return getMe(db, userId);
}
