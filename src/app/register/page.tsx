import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getConfig } from "@/lib/config";
import { ro } from "@/messages/ro";

import { Logo } from "../_components/logo";

export const metadata: Metadata = { title: ro.register.title };

/**
 * `/register`: în `personal` nu există (404; conturile le creează CLI-ul). În `saas`,
 * înregistrarea publică cu verificarea emailului vine în Faza 11: până atunci, un mesaj onest
 * (și `/api/auth/sign-up/email` rămâne închis).
 */
export default function RegisterPage() {
  let mode: string | null = null;
  try {
    mode = getConfig().appMode;
  } catch {
    mode = null;
  }
  if (mode !== "saas") notFound();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div className="flex justify-center">
        <Logo className="text-5xl" />
      </div>
      <Card>
        <h1 className="mb-2 text-2xl font-bold">{ro.register.title}</h1>
        <p className="mb-5 text-muted-foreground">{ro.register.unavailable}</p>
        <Link href="/login" className={buttonClasses("outline")}>
          {ro.register.backToLogin}
        </Link>
      </Card>
    </main>
  );
}
