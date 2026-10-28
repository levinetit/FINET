import Link from "next/link";
import type { ReactNode } from "react";

import { formatMinor } from "@/app/_lib/ledger-ui";
import {
  type DeltaJson,
  deltaView,
  formatAbsMinor,
  formatDate,
  formatMonth,
  progressLength,
} from "@/app/_lib/planning-ui";
import type { Currency } from "@/lib/money";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";
import type { BudgetStatusJson } from "@/modules/budgets/budgets.schema";
import type { GoalJson } from "@/modules/goals/goals.schema";

import { Bar, StatusBadge, toneOf } from "./charts";

/**
 * Piesele comune ale paginilor de planificare (F3-C): cardul unui total cu comparația față de
 * luna anterioară, avertizarea bugetelor, rândul unui buget și al unui obiectiv. Componente de
 * server, fără stare; sumele doar prin `formatMinor` (money.ts).
 */

const ARROWS = { up: "↑", down: "↓", flat: "→", none: "" } as const;

/** Un total al lunii (venituri, cheltuieli, net, număr) cu săgeata și procentul. */
export function StatCard({
  label,
  value,
  delta,
  previousMonth,
  testId,
}: Readonly<{
  label: string;
  value: ReactNode;
  delta: DeltaJson;
  previousMonth: string;
  testId: string;
}>) {
  const d = deltaView(delta);
  const t = ro.dashboard;
  const spoken = d.direction === "none" ? t.noComparisonHint : t[d.direction];
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-md bg-surface-2 px-4 py-3"
      data-testid={testId}
    >
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xl font-semibold tabular-nums" data-testid="stat-value">
        {value}
      </dd>
      <dd className="text-xs text-muted-foreground">
        <span
          className="font-semibold text-fg"
          data-testid="stat-delta"
          data-direction={d.direction}
        >
          <span aria-hidden>{ARROWS[d.direction]} </span>
          {d.text}
        </span>{" "}
        <span className="sr-only">({spoken}) </span>
        {t.vsPrevious(formatMonth(previousMonth))}
      </dd>
    </div>
  );
}

/**
 * Avertizarea în aplicație: bugetele galbene și roșii ale lunii afișate (pe dashboard și pe
 * `/budgets`, ADR 0008). Nimic dacă toate sunt verzi.
 */
export function BudgetAlert({
  statuses,
  month,
  link = true,
}: Readonly<{ statuses: readonly BudgetStatusJson[]; month: string; link?: boolean }>) {
  const red = statuses.filter((s) => s.status === "red").length;
  const yellow = statuses.filter((s) => s.status === "yellow").length;
  if (red + yellow === 0) return null;
  return (
    <section
      aria-labelledby="budget-alert-title"
      className={cn(
        "flex flex-col gap-1 rounded-md border px-4 py-3",
        red > 0 ? "border-bad bg-bad-soft" : "border-warn bg-warn-soft",
      )}
      data-testid="budget-alert"
    >
      <h2 id="budget-alert-title" className="font-bold">
        {ro.planning.alertTitle}
      </h2>
      <p className="text-sm">{ro.planning.alertText(yellow, red, formatMonth(month))}</p>
      {link ? (
        <Link
          href={`/budgets?month=${month}`}
          className="text-sm font-medium text-primary hover:underline"
        >
          {ro.planning.alertLink}
        </Link>
      ) : null}
    </section>
  );
}

/** Numele afișat al unui buget: categoria sau „General”, plus domeniul personal. */
export function budgetName(
  b: Pick<BudgetStatusJson, "categoryId" | "scope">,
  categoryName: ReadonlyMap<string, string>,
): string {
  const base = b.categoryId ? (categoryName.get(b.categoryId) ?? "—") : ro.budgets.generalShort;
  return b.scope === "personal" ? `${base} · ${ro.budgets.scopeShort.personal}` : base;
}

/** Rândul unui buget cu semaforul, bara (cu pragul) și sumele. */
export function BudgetLine({
  status,
  name,
  href,
}: Readonly<{ status: BudgetStatusJson; name: string; href?: string }>) {
  const c = status.currency as Currency;
  const t = ro.budgets;
  const label = t.progressLabel(name, status.percent, ro.planning.status[status.status] ?? "");
  const title = href ? (
    <Link href={href} className="truncate font-semibold hover:text-primary">
      {name}
    </Link>
  ) : (
    <span className="truncate font-semibold">{name}</span>
  );
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid="budget-line"
      data-budget-id={status.id}
      data-status={status.status}
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {title}
          <StatusBadge status={status.status} />
        </span>
        <span
          className="font-mono text-sm whitespace-nowrap tabular-nums"
          data-testid="budget-percent"
        >
          {t.percent(status.percent)}
        </span>
      </span>
      <Bar
        length={progressLength(status.percent)}
        tone={toneOf(status.status)}
        marker={status.warnPct}
        label={label}
      />
      <span className="flex flex-wrap justify-between gap-2 text-sm text-muted-foreground">
        <span>
          {t.spent}:{" "}
          <span className="font-mono text-fg tabular-nums" data-testid="budget-spent">
            {formatMinor(status.spentMinor, c)}
          </span>{" "}
          {t.of(formatMinor(status.amountMinor, c))}
        </span>
        <span>
          {status.remainingMinor < 0 ? t.over : t.remaining}:{" "}
          <span className="font-mono text-fg tabular-nums">
            {formatAbsMinor(status.remainingMinor, c)}
          </span>
        </span>
      </span>
    </div>
  );
}

/** Rândul unui obiectiv: progres, sume, termen, stare. */
export function GoalLine({ goal, href }: Readonly<{ goal: GoalJson; href?: string }>) {
  const c = goal.currency as Currency;
  const t = ro.goals;
  const title = href ? (
    <Link href={href} className="truncate font-semibold hover:text-primary">
      {goal.name}
    </Link>
  ) : (
    <span className="truncate font-semibold">{goal.name}</span>
  );
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid="goal-line"
      data-goal-id={goal.id}
      data-status={goal.status}
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {title}
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-xs font-semibold",
              goal.status === "achieved"
                ? "bg-ok-soft"
                : goal.status === "abandoned"
                  ? "bg-surface-2 text-muted-foreground"
                  : "bg-accent-soft",
            )}
            data-testid="goal-status"
          >
            {t.statuses[goal.status]}
          </span>
        </span>
        <span
          className="font-mono text-sm whitespace-nowrap tabular-nums"
          data-testid="goal-progress"
        >
          {t.progress(goal.progressPct)}
        </span>
      </span>
      <Bar
        length={progressLength(goal.progressPct)}
        tone={goal.status === "achieved" ? "ok" : "primary"}
        label={t.progressLabel(goal.name, goal.progressPct)}
      />
      <span className="flex flex-wrap justify-between gap-2 text-sm text-muted-foreground">
        <span>
          {t.saved}:{" "}
          <span className="font-mono text-fg tabular-nums" data-testid="goal-saved">
            {formatMinor(goal.savedMinor, c)}
          </span>{" "}
          {ro.budgets.of(formatMinor(goal.targetMinor, c))}
        </span>
        <span>{goal.deadline ? t.until(formatDate(goal.deadline)) : t.noDeadline}</span>
      </span>
    </div>
  );
}
