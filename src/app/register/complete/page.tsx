import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getConfig } from "@/lib/config";
import { ro } from "@/messages/ro";

import { Logo } from "../../_components/logo";

import { CompleteForm } from "./complete-form";

export const metadata: Metadata = { title: ro.registerComplete.title, robots: { index: false } };

/** Pasul 2 al înregistrării publice (ADR 0029): doar `saas` cu `SIGNUP_ENABLED=1`; altfel 404. */
export default async function CompleteRegisterPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  let open = false;
  try {
    const config = getConfig();
    open = config.appMode === "saas" && config.auth.signupEnabled && config.notify.smtp !== null;
  } catch {
    open = false;
  }
  if (!open) notFound();
  const raw = (await searchParams).token;
  const token = typeof raw === "string" ? raw : "";
  const t = ro.registerComplete;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div className="flex justify-center">
        <Logo className="text-5xl" />
      </div>
      <Card>
        <h1 className="mb-2 text-2xl font-bold">{t.title}</h1>
        {token ? (
          <>
            <p className="mb-5 text-muted-foreground">{t.intro}</p>
            <CompleteForm token={token} />
          </>
        ) : (
          <div className="flex flex-col gap-4">
            <Alert data-testid="register-no-token">{t.missingToken}</Alert>
            <Link href="/register" className={buttonClasses("outline")}>
              {t.restart}
            </Link>
          </div>
        )}
      </Card>
    </main>
  );
}
