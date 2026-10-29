"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";

import { apiFetch, goToLogin } from "../../_lib/api-client";
import { type ScanSummary, offlineScans } from "../../_lib/offline-scans-client";
import {
  ACCEPTED_TYPES,
  MAX_FILES,
  SETTLED_DOCUMENT_STATUSES,
  documentErrorText,
  documentStatusText,
  moveItem,
  nextPollDelay,
  selectionProblem,
} from "../../_lib/receipts-ui";
import { CLIENT_HEADER_NAME, clientHeaderFor } from "../../_lib/usage-client";
import { useHydrated } from "../../_lib/use-hydrated";

export type RecentDocument = Readonly<{
  id: string;
  status: string;
  errorCode: string | null;
  receiptId: string | null;
  batchId: string | null;
  documentOrder: number | null;
  createdAt: string;
}>;

type Usage = Readonly<{ used: number; limit: number }>;

type Picked = Readonly<{
  key: string;
  file: File;
  /** Previzualizarea ca `data:` URL (CSP: `img-src 'self' data:`; fără `blob:`, ADR 0015). */
  preview: string | null;
}>;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
/** Previzualizare doar pentru imagini mici (o poză de 10 MB ar ocupa ~13 MB ca text). */
const PREVIEW_MAX_BYTES = 6 * 1024 * 1024;

function readPreview(file: File): Promise<string | null> {
  if (!IMAGE_TYPES.has(file.type) || file.size > PREVIEW_MAX_BYTES) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(
        typeof reader.result === "string" && reader.result.startsWith("data:image/")
          ? reader.result
          : null,
      );
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/**
 * Zona de încărcare și starea documentelor (ADR 0015). Fișierele se trimit într-o singură cerere
 * `multipart/form-data` la `POST /api/v1/documents` (cookie + `Origin`, ca orice mutație), fără
 * să fie citite în JavaScript, cu excepția previzualizării. Numele fișierelor nu sunt folosite
 * nicăieri (serverul generează numele). Polling-ul (`GET /api/v1/documents/{id}`) se oprește la
 * stările finale, crește pauza treptat și se suspendă cât tab-ul e ascuns.
 */
export function ImportClient({
  initialUsage,
  initialRecent,
  externalAi,
  maxUploadBytes,
}: Readonly<{
  initialUsage: Usage;
  initialRecent: readonly RecentDocument[];
  externalAi: boolean;
  /** `MAX_UPLOAD_MB` în octeți: plafonul pozelor păstrate offline (Faza 9). */
  maxUploadBytes: number;
}>) {
  const t = ro.imports;
  const hydrated = useHydrated();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [longReceipt, setLongReceipt] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage>(initialUsage);
  const [docs, setDocs] = useState<RecentDocument[]>([...initialRecent]);
  const seq = useRef(0);
  // Faza 9 (ADR 0020): coada offline (IndexedDB) și starea conexiunii.
  const queue = offlineScans();
  const offline = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getServerSnapshot);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  // Documentele confirmate de server la încărcarea din coadă apar în „Încărcate recent”.
  useEffect(
    () =>
      queue.onUploaded((created) => {
        const fresh: RecentDocument[] = created.flatMap((d) =>
          typeof d.id === "string" && typeof d.status === "string"
            ? [
                {
                  id: d.id,
                  status: d.status,
                  errorCode: typeof d.errorCode === "string" ? d.errorCode : null,
                  receiptId: null,
                  batchId: typeof d.batchId === "string" ? d.batchId : null,
                  documentOrder: typeof d.documentOrder === "number" ? d.documentOrder : null,
                  createdAt: typeof d.createdAt === "string" ? d.createdAt : "",
                },
              ]
            : [],
        );
        setDocs((current) => {
          const ids = new Set(fresh.map((d) => d.id));
          return [...fresh, ...current.filter((d) => !ids.has(d.id))];
        });
        setInfo(ro.offline.uploaded(1));
      }),
    [queue],
  );

  const addFiles = useCallback(
    async (list: FileList | readonly File[]) => {
      setError(null);
      setInfo(null);
      const files = Array.from(list);
      const room = MAX_FILES - picked.length;
      if (files.length > room) setError(t.tooMany);
      const accepted = files.slice(0, Math.max(0, room));
      const next = await Promise.all(
        accepted.map(async (file) => ({
          key: `f${++seq.current}`,
          file,
          preview: await readPreview(file),
        })),
      );
      setPicked((current) => [...current, ...next].slice(0, MAX_FILES));
    },
    [picked.length, t.tooMany],
  );

  async function upload() {
    setError(null);
    setInfo(null);
    const problem = selectionProblem(
      picked.map((p) => ({ name: p.file.name, type: p.file.type, size: p.file.size })),
      longReceipt,
    );
    if (problem) {
      setError(problem);
      return;
    }
    if (navigator.onLine === false) {
      await saveOffline();
      return;
    }
    const form = new FormData();
    form.append("kind", "receipt");
    if (longReceipt) form.append("longReceipt", "true");
    // Numele trimis e generic: serverul nu-l folosește, iar numele real poate conține date.
    picked.forEach((p, i) => form.append("files", p.file, `bon-${i + 1}`));
    const headers: Record<string, string> = {};
    const client = clientHeaderFor("/api/v1/documents");
    if (client) headers[CLIENT_HEADER_NAME] = client;
    setUploading(true);
    try {
      let response: Response;
      try {
        response = await fetch("/api/v1/documents", {
          method: "POST",
          body: form,
          credentials: "same-origin",
          cache: "no-store",
          headers,
        });
      } catch {
        // Fără rețea (Wi-Fi-ul magazinului poate „minți” despre `onLine`): pozele merg în coadă.
        if (offline.available) await saveOffline();
        else setError(ro.ledger.errors.network);
        return;
      }
      if (response.status === 401) return goToLogin();
      const body = (await response.json().catch(() => null)) as {
        data?: { documents: (RecentDocument & { duplicate: boolean })[] };
        error?: { code: string; reason?: string };
      } | null;
      if (!response.ok || !body?.data) {
        const code = body?.error?.code;
        const reason = body?.error?.reason;
        if (response.status === 429) setError(ro.ledger.errors.rateLimited);
        else if (response.status === 409 && reason)
          setError(ro.ledger.errors.reasons[reason] ?? t.errors.generic!);
        else if (response.status === 400 && code === "invalid_request") setError(t.statementsLater);
        else setError(documentErrorText(code));
        return;
      }
      const created = body.data.documents;
      setDocs((current) => {
        const ids = new Set(created.map((d) => d.id));
        return [...created, ...current.filter((d) => !ids.has(d.id))];
      });
      const duplicates = created.filter((d) => d.duplicate).length;
      setInfo(duplicates > 0 ? `${t.duplicate}: ${duplicates}` : null);
      setPicked([]);
      setLongReceipt(false);
      if (inputRef.current) inputRef.current.value = "";
      const u = await apiFetch<Usage>("/api/v1/ai/usage", { method: "GET" });
      if (u.ok && u.data) setUsage(u.data);
    } finally {
      setUploading(false);
    }
  }

  /** Păstrează selecția curentă în coada offline (ADR 0020). */
  async function saveOffline() {
    const result = await queue.enqueue(
      picked.map((p) => p.file),
      longReceipt,
      maxUploadBytes,
    );
    if (!result.ok) {
      setError(ro.offline.errors[result.code] ?? ro.offline.errors.offline_unavailable!);
      return;
    }
    setInfo(ro.offline.savedOffline);
    setPicked([]);
    setLongReceipt(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  // Polling blând pentru documentele care încă se procesează.
  const pending = docs.filter((d) => !SETTLED_DOCUMENT_STATUSES.has(d.status));
  const pendingKey = pending.map((d) => d.id).join(",");
  useEffect(() => {
    if (pendingKey === "") return;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const ids = pendingKey.split(",");
    const tick = async () => {
      if (stopped) return;
      if (document.hidden) {
        timer = setTimeout(tick, 5000);
        return;
      }
      const updates = await Promise.all(
        ids.map((id) => apiFetch<RecentDocument>(`/api/v1/documents/${id}`, { method: "GET" })),
      );
      if (stopped) return;
      if (updates.some((u) => u.status === 401)) return goToLogin();
      setDocs((current) =>
        current.map((d) => {
          const u = updates.find((x) => x.ok && x.data?.id === d.id);
          return u?.data ? { ...d, ...u.data } : d;
        }),
      );
      const delay = nextPollDelay(++attempt);
      if (delay !== null) timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, nextPollDelay(0) ?? 3000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [pendingKey]);

  const disabled = !hydrated || uploading;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-semibold" data-testid="import-usage">
            {t.usage(usage.used, usage.limit)}
          </p>
          <p className="text-sm text-muted-foreground">
            <Link href="/import?tip=extras" className="text-primary underline">
              {t.statementsLater}
            </Link>
          </p>
        </div>
      </Card>

      {!online ? (
        <Alert tone="info" data-testid="offline-banner">
          {offline.available ? ro.offline.offlineNow : ro.offline.unavailable}
        </Alert>
      ) : null}

      {offline.scans.length > 0 ? (
        <OfflineQueue
          scans={offline.scans}
          syncing={offline.syncing}
          needsAuth={offline.needsAuth}
          onRetry={(id) => void queue.retry(id)}
          onRemove={(id) => void queue.remove(id)}
        />
      ) : null}

      {!externalAi ? (
        <Alert tone="info" data-testid="consent-missing">
          {t.consentMissing}{" "}
          <Link href="/profile#external-ai" className="font-semibold text-primary underline">
            {t.consentLink}
          </Link>{" "}
          ·{" "}
          <Link href="/transactions/new" className="font-semibold text-primary underline">
            {t.manualLink}
          </Link>
        </Alert>
      ) : null}

      <Card aria-labelledby="upload-title">
        <CardHeader>
          <CardTitle id="upload-title">{t.dropLabel}</CardTitle>
          <CardDescription id="upload-hint">{t.dropHint}</CardDescription>
        </CardHeader>
        <div
          data-testid="drop-zone"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!disabled) void addFiles(e.dataTransfer.files);
          }}
          className={cn(
            "flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-6 text-center",
            dragging ? "border-primary bg-accent" : "border-border",
          )}
        >
          <label htmlFor={inputId} className={buttonClasses("secondary")}>
            {t.choose}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            multiple
            accept={ACCEPTED_TYPES}
            aria-describedby="upload-hint"
            className="sr-only"
            disabled={disabled}
            data-testid="file-input"
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {picked.length > 0 ? t.selected(picked.length) : null}
          </p>
        </div>

        <fieldset className="mt-4 flex flex-col gap-2 rounded-md border border-border p-3">
          <legend className="px-1 font-semibold">{t.longMode}</legend>
          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              role="switch"
              className="size-5 accent-[var(--accent)]"
              checked={longReceipt}
              disabled={disabled}
              aria-describedby="long-hint"
              data-testid="long-mode"
              onChange={(e) => setLongReceipt(e.target.checked)}
            />
            <span>{t.longMode}</span>
          </label>
          <p id="long-hint" className="text-sm text-muted-foreground">
            {t.longModeHint}
          </p>
        </fieldset>

        {picked.length > 0 ? (
          <div className="mt-4">
            <h3 className="mb-2 font-semibold">
              {longReceipt ? t.longOrder : t.selected(picked.length)}
            </h3>
            <ol className="flex flex-col gap-2" data-testid="picked-list">
              {picked.map((p, i) => (
                <li
                  key={p.key}
                  className="flex flex-wrap items-center gap-3 rounded-md border border-border p-2"
                >
                  {p.preview ? (
                    // eslint-disable-next-line @next/next/no-img-element -- previzualizare locală (`data:`), nu o imagine optimizabilă
                    <img
                      src={p.preview}
                      alt={t.preview(longReceipt ? t.part(i + 1) : `${i + 1}`)}
                      className="h-16 w-12 rounded object-cover"
                    />
                  ) : (
                    <span className="flex h-16 w-12 items-center justify-center rounded bg-muted text-xs">
                      {p.file.type === "application/pdf" ? "PDF" : "—"}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 text-sm">
                    {longReceipt ? <strong>{t.part(i + 1)}</strong> : `${i + 1}.`}
                  </span>
                  {longReceipt ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={disabled || i === 0}
                        aria-label={`${t.moveUp}: ${t.part(i + 1)}`}
                        onClick={() => setPicked((c) => moveItem(c, i, -1))}
                      >
                        ↑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={disabled || i === picked.length - 1}
                        aria-label={`${t.moveDown}: ${t.part(i + 1)}`}
                        onClick={() => setPicked((c) => moveItem(c, i, 1))}
                      >
                        ↓
                      </Button>
                    </>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    aria-label={`${t.remove}: ${i + 1}`}
                    onClick={() => setPicked((c) => c.filter((x) => x.key !== p.key))}
                  >
                    {t.remove}
                  </Button>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            disabled={disabled || picked.length === 0}
            onClick={() => void upload()}
            data-testid="upload"
          >
            {uploading ? t.uploading : online ? t.upload : ro.offline.saveOffline}
          </Button>
          {picked.length > 0 ? (
            <Button variant="ghost" disabled={disabled} onClick={() => setPicked([])}>
              {t.clear}
            </Button>
          ) : null}
        </div>
        <Alert className="mt-3">{error}</Alert>
        <Alert tone="ok" className="mt-3">
          {info}
        </Alert>
      </Card>

      <Card aria-labelledby="recent-title">
        <CardHeader>
          <CardTitle id="recent-title">{t.recent}</CardTitle>
        </CardHeader>
        {docs.length === 0 ? (
          <p className="text-muted-foreground">{t.noRecent}</p>
        ) : (
          <ul
            className="flex flex-col divide-y divide-border"
            data-testid="recent-list"
            aria-live="polite"
          >
            {docs.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
                data-testid="document-row"
                data-status={d.status}
              >
                <span className="flex flex-col">
                  <span className="font-medium" data-testid="document-status">
                    {documentStatusText(d.status)}
                    {d.documentOrder !== null ? ` · ${t.part(d.documentOrder)}` : ""}
                  </span>
                  {d.status === "rejected" || d.status === "failed" ? (
                    <span className="text-sm text-bad">{documentErrorText(d.errorCode)}</span>
                  ) : null}
                </span>
                {d.receiptId ? (
                  <Link
                    href={`/receipts/${d.receiptId}`}
                    className={buttonClasses("outline", "sm")}
                    data-testid="view-receipt"
                  >
                    {t.viewReceipt}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const timeFormat = new Intl.DateTimeFormat("ro-RO", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Bucharest",
});

/** Lista încărcărilor în așteptare pe acest dispozitiv (Faza 9, ADR 0020). */
function OfflineQueue({
  scans,
  syncing,
  needsAuth,
  onRetry,
  onRemove,
}: Readonly<{
  scans: readonly ScanSummary[];
  syncing: boolean;
  needsAuth: boolean;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}>) {
  const t = ro.offline;
  return (
    <Card aria-labelledby="offline-title" data-testid="offline-queue">
      <CardHeader>
        <CardTitle id="offline-title">{t.title}</CardTitle>
        <CardDescription>{t.hint}</CardDescription>
      </CardHeader>
      <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
        {syncing ? t.syncing : null}
      </p>
      {needsAuth ? <Alert tone="info">{t.needsAuth}</Alert> : null}
      <ul className="flex flex-col divide-y divide-border">
        {scans.map((s) => {
          const what = t.entry(s.files, s.longReceipt);
          return (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              data-testid="offline-scan"
              data-state={s.state}
            >
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">
                  {what} · {s.state === "failed" ? t.stateFailed : t.statePending}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t.savedAt(timeFormat.format(new Date(s.createdAt)))}
                </span>
                {s.otherHousehold ? (
                  <span className="text-sm text-muted-foreground">{t.otherHousehold}</span>
                ) : s.errorCode ? (
                  <span
                    className={cn(
                      "text-sm",
                      s.state === "failed" ? "text-bad" : "text-muted-foreground",
                    )}
                  >
                    {t.errors[s.errorCode] ?? documentErrorText(s.errorCode)}
                  </span>
                ) : null}
              </span>
              <span className="flex gap-2">
                {s.state === "failed" && !s.otherHousehold ? (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t.retryLabel(what)}
                    onClick={() => onRetry(s.id)}
                  >
                    {t.retry}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t.removeLabel(what)}
                  onClick={() => onRemove(s.id)}
                >
                  {t.remove}
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
