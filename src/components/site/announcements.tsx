import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import type { AnnouncementView } from "@/modules/admin/admin.service";
import { ro } from "@/messages/ro";

/** Anunțurile active ale administratorului (F11-B, ADR 0028), deasupra conținutului, doar în `saas`. */
export function Announcements({ items }: Readonly<{ items: readonly AnnouncementView[] }>) {
  if (items.length === 0) return null;
  return (
    <div
      className="mb-3 flex flex-col gap-2"
      role="region"
      aria-label="Anunțuri"
      data-testid="announcements"
    >
      {items.map((a) => (
        <Alert key={a.id} tone={a.level === "warn" ? "error" : "info"}>
          <strong>{a.title}.</strong> {a.body}
        </Alert>
      ))}
    </div>
  );
}

export function FeedbackLink() {
  return (
    <p className="mt-8 text-sm">
      <Link href="/feedback" data-testid="feedback-link">
        {ro.feedback.link}
      </Link>
    </p>
  );
}
