import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { ro } from "@/messages/ro";

import { Logo } from "./_components/logo";

// Pagina 404 proprie: cea implicită din Next folosește atribute `style`, blocate de CSP.
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <Logo className="text-4xl" />
      <h1 className="text-2xl font-bold">{ro.common.notFoundTitle}</h1>
      <p className="text-muted-foreground">{ro.common.notFoundBody}</p>
      <Link href="/" className={buttonClasses("outline")}>
        {ro.common.backHome}
      </Link>
    </main>
  );
}
