import { redirect } from "next/navigation";

import { DEFAULT_AFTER_LOGIN } from "./_lib/next-path";
import { getPageSession } from "./_lib/session";

/** `/`: spre dashboard cu sesiune, altfel spre login. */
export default async function HomePage() {
  const session = await getPageSession();
  redirect(session ? DEFAULT_AFTER_LOGIN : "/login");
}
