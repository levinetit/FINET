"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ro } from "@/messages/ro";

import { useSubmit } from "../../_lib/use-submit";

/** Acțiunile panoului de administrare (F11-B): fiecare apel e un `PATCH`/`POST` către `/api/v1/admin/*`. */
function useAction() {
  const router = useRouter();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  async function run(path: string, method: "PATCH" | "POST", body: unknown): Promise<boolean> {
    setError(null);
    const result = await submit(path, method, body);
    if (!result) return false;
    if (!result.ok) {
      setError(ro.admin.failed);
      return false;
    }
    router.refresh();
    return true;
  }
  return { run, pending, error };
}

export function FeedbackStatus({ id, status }: Readonly<{ id: string; status: string }>) {
  const { run, pending, error } = useAction();
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <Select
        aria-label={ro.admin.status}
        defaultValue={status}
        disabled={pending}
        onChange={(e) =>
          void run(`/api/v1/admin/feedback/${id}`, "PATCH", { status: e.target.value })
        }
        data-testid="feedback-status"
      >
        <option value="new">new</option>
        <option value="seen">seen</option>
        <option value="closed">closed</option>
      </Select>
      <Alert>{error}</Alert>
    </div>
  );
}

export function UserStatusButton({ id, status }: Readonly<{ id: string; status: string }>) {
  const { run, pending, error } = useAction();
  const next = status === "active" ? "disabled" : "active";
  return (
    <>
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => void run(`/api/v1/admin/users/${id}`, "PATCH", { status: next })}
      >
        {status === "active" ? ro.admin.disable : ro.admin.enable}
      </Button>
      <Alert>{error}</Alert>
    </>
  );
}

export function ArchiveButton({ id }: Readonly<{ id: string }>) {
  const { run, pending, error } = useAction();
  return (
    <>
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => void run(`/api/v1/admin/announcements/${id}`, "PATCH", { archived: true })}
      >
        {ro.admin.archive}
      </Button>
      <Alert>{error}</Alert>
    </>
  );
}

export function AnnouncementForm() {
  const t = ro.admin;
  const { run, pending, error } = useAction();
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const ok = await run("/api/v1/admin/announcements", "POST", {
      title: String(data.get("title") ?? ""),
      body: String(data.get("body") ?? ""),
      level: String(data.get("level")),
    });
    if (ok) form.reset();
  }
  return (
    <form
      method="post"
      onSubmit={onSubmit}
      aria-label={t.newAnnouncement}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ann-title">{t.title_}</Label>
        <Input id="ann-title" name="title" maxLength={100} required data-testid="ann-title" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ann-body">{t.body}</Label>
        <Input id="ann-body" name="body" maxLength={500} required data-testid="ann-body" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ann-level">{t.level}</Label>
        <Select id="ann-level" name="level" defaultValue="info">
          <option value="info">{t.levels.info}</option>
          <option value="warn">{t.levels.warn}</option>
        </Select>
      </div>
      <Alert>{error}</Alert>
      <div>
        <Button type="submit" disabled={pending} data-testid="ann-submit">
          {t.create}
        </Button>
      </div>
    </form>
  );
}
