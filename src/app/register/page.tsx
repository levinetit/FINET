import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getConfig } from "@/lib/config";
import { ro } from "@/messages/ro";

import { Logo } from "../_components/logo";

import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: ro.register.title };

/**
 * `/register`: în `personal` nu există (404; conturile le creează CLI-ul). În `saas`, formularul
 * apare doar cu `SIGNUP_ENABLED=1` ȘI SMTP configurat (ADR 0029); altfel, un mesaj onest
 * („încă nu e deschisă”). `/api/auth/sign-up/email` rămâne închis în ambele cazuri.
 */
export default function RegisterPage() {
  let mode: string | null = null;
  let open = false;
  try {
    const config = getConfig();
    mode = config.appMode;
    open = config.auth.signupEnabled && config.notify.smtp !== null;
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
        {open ? (
          <>
            <p className="mb-5 text-muted-foreground">{ro.register.intro}</p>
            <RegisterForm />
            <p className="mt-5 text-center text-sm">
              <Link href="/login">{ro.register.backToLogin}</Link>
            </p>
          </>
        ) : (
          <>
            <p className="mb-5 text-muted-foreground" data-testid="register-unavailable">
              {ro.register.unavailable}
            </p>
            <Link href="/login" className={buttonClasses("outline")}>
              {ro.register.backToLogin}
            </Link>
          </>
        )}
      </Card>
    </main>
  );
}
