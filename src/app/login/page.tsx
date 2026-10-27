import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Card } from "@/components/ui/card";
import { getConfig } from "@/lib/config";
import { ro } from "@/messages/ro";

import { Logo } from "../_components/logo";
import { safeNextPath } from "../_lib/next-path";
import { getPageSession } from "../_lib/session";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: ro.login.title };

/** Magic link-ul se oferă doar cu SMTP configurat (flag calculat pe server, fără secrete). */
function magicLinkEnabled(): boolean {
  try {
    return getConfig().notify.smtp !== null;
  } catch {
    return false;
  }
}

export default async function LoginPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const next = safeNextPath((await searchParams).next);
  if (await getPageSession()) redirect(next);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div className="flex flex-col items-center gap-2 text-center">
        <Logo className="text-5xl" />
        <p className="text-sm text-muted-foreground">{ro.app.tagline}</p>
      </div>
      <Card>
        <h1 className="mb-1 text-2xl font-bold">{ro.login.title}</h1>
        <p className="mb-5 text-sm text-muted-foreground">{ro.login.subtitle}</p>
        <LoginForm next={next} magicLink={magicLinkEnabled()} />
      </Card>
      <p className="text-center text-sm text-muted-foreground">{ro.login.noAccount}</p>
    </main>
  );
}
