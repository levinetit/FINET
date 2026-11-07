import Link from "next/link";

import { Bar } from "@/components/planning/charts";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Currency } from "@/lib/money";
import { ro } from "@/messages/ro";
import type { EmergencyJson, GoalPlanJson, PlanJson } from "@/modules/goals/plan.schema";

import { formatMinor } from "../../_lib/ledger-ui";
import { progressLength } from "../../_lib/planning-ui";

/**
 * Componentele planului de economisire (ADR 0047), randate pe server: rata necesară pe obiectiv și
 * fondul de urgență pe monedă. Sumele vin gata calculate (întregi) din serviciu.
 */

export function PlanLine({ plan, currency }: Readonly<{ plan: PlanJson; currency: Currency }>) {
  const t = ro.savings;
  if (plan.status !== "on_track") {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="plan-status"
        data-plan-status={plan.status}
      >
        {t.statuses[plan.status]}
      </p>
    );
  }
  return (
    <p
      className="text-sm text-muted-foreground"
      data-testid="plan-status"
      data-plan-status={plan.status}
    >
      {t.remaining} {formatMinor(plan.remainingMinor, currency)} · {t.daysLeft(plan.daysLeft ?? 0)}{" "}
      ·{" "}
      <span className="font-mono tabular-nums">{formatMinor(plan.dailyMinor ?? 0, currency)}</span>{" "}
      {t.perDay} ·{" "}
      <span className="font-mono tabular-nums">{formatMinor(plan.weeklyMinor ?? 0, currency)}</span>{" "}
      {t.perWeek} ·{" "}
      <span className="font-mono tabular-nums">
        {formatMinor(plan.monthlyMinor ?? 0, currency)}
      </span>{" "}
      {t.perMonth}
    </p>
  );
}

export function GoalPlans({ goals }: Readonly<{ goals: readonly GoalPlanJson[] }>) {
  const t = ro.savings;
  if (goals.length === 0) return null;
  return (
    <Card aria-labelledby="savings-plan-title" data-testid="savings-plan">
      <CardHeader>
        <CardTitle id="savings-plan-title">{t.planTitle}</CardTitle>
        <CardDescription>{t.planHint}</CardDescription>
      </CardHeader>
      <ul className="flex flex-col gap-3">
        {goals.map((g) => (
          <li
            key={g.goalId}
            className="flex flex-col gap-0.5"
            data-testid="goal-plan"
            data-goal-id={g.goalId}
          >
            <Link href={`/goals/${g.goalId}`} className="font-medium hover:text-primary">
              {g.name}
            </Link>
            <PlanLine plan={g.plan} currency={g.currency as Currency} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function EmergencyFund({ plans }: Readonly<{ plans: readonly EmergencyJson[] }>) {
  const t = ro.savings;
  return (
    <Card aria-labelledby="emergency-title" data-testid="emergency-fund">
      <CardHeader>
        <CardTitle id="emergency-title">{t.emergencyTitle}</CardTitle>
        <CardDescription>{t.emergencyHint}</CardDescription>
      </CardHeader>
      {plans.length === 0 || plans.every((p) => p.options.length === 0) ? (
        <p className="text-sm text-muted-foreground">{t.emergencyNoData}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {plans
            .filter((p) => p.options.length > 0)
            .map((p) => {
              const c = p.currency as Currency;
              return (
                <li
                  key={p.currency}
                  className="flex flex-col gap-2"
                  data-testid={`emergency-${p.currency}`}
                >
                  <p className="text-sm">
                    <span className="font-semibold">{p.currency}</span> ·{" "}
                    {t.emergencyAverage(formatMinor(p.averageExpenseMinor ?? 0, c))}{" "}
                    {t.emergencyLiquid(formatMinor(p.liquidMinor, c))}
                  </p>
                  {p.options.map((o) => (
                    <div key={o.months} className="flex flex-col gap-1">
                      <div className="flex flex-wrap justify-between gap-x-3 text-sm">
                        <span>{t.emergencyOption(o.months, formatMinor(o.targetMinor, c))}</span>
                        <span className="text-muted-foreground">
                          {o.gapMinor === 0
                            ? t.emergencyReached
                            : t.emergencyGap(
                                formatMinor(o.gapMinor, c),
                                formatMinor(o.monthlyMinor, c),
                              )}
                        </span>
                      </div>
                      <Bar
                        length={progressLength(o.coveredPct)}
                        tone={o.gapMinor === 0 ? "ok" : "primary"}
                        label={`${t.emergencyOption(o.months, formatMinor(o.targetMinor, c))}: ${t.emergencyCovered(`${o.coveredPct} %`)}`}
                      />
                    </div>
                  ))}
                </li>
              );
            })}
        </ul>
      )}
    </Card>
  );
}
