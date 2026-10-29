import type { Metadata } from "next";
import { Fragment } from "react";

import { budgetName } from "@/components/planning/summary";
import { Alert } from "@/components/ui/alert";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ro } from "@/messages/ro";
import { accountToJson } from "@/modules/accounts/accounts.schema";
import { listAccounts } from "@/modules/accounts/accounts.service";
import { budgetToJson } from "@/modules/budgets/budgets.schema";
import { listBudgets } from "@/modules/budgets/budgets.service";
import { listCategories } from "@/modules/categories/categories.service";
import {
  balancesToJson,
  inviteToJson,
  memberToJson,
  settlementToJson,
  splitToJson,
} from "@/modules/family/family.schema";
import { listInvites } from "@/modules/family/invites.service";
import { listMembers } from "@/modules/family/members.service";
import { getBalances, listSettlements } from "@/modules/family/settlements.service";
import { listSplits } from "@/modules/family/splits.service";

import { memberName } from "../../_lib/family-ui";
import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { formatCalendarDate, formatMinor, todayIn } from "../../_lib/ledger-ui";
import { PageHeader } from "../page-header";

import { InvitesPanel } from "./invites-panel";
import { MembersPanel } from "./members-panel";
import { SettlementCancel, SettlementForm } from "./settlement-form";

export const metadata: Metadata = { title: ro.family.title };

/**
 * Familia (Faza 8, ADR 0016): membrii și rolurile, invitațiile (doar owner), soldurile reciproce
 * (cine cui datorează, pe monedă; foștii membri apar fără nume), decontările (inclusiv parțiale,
 * anulabile de oricare parte), împărțirile recente și ce e comun vs personal. Totul citit pe
 * server, prin servicii, cu RLS-ul utilizatorului; actualizat live (`LiveUpdates` din layout).
 */
export default async function FamilyPage() {
  const page = await requireLedgerPage("/family");
  const t = ro.family;
  if (!page.householdId) {
    return (
      <>
        <PageHeader title={t.title} usageStats={page.usageStats} />
        <Card>
          <p className="text-muted-foreground">{t.noHousehold}</p>
        </Card>
      </>
    );
  }
  const householdId = page.householdId;
  const { db } = page.session.runtime;
  const deps = { db };
  const me = page.actor.userId.toLowerCase();
  const result = await load(async () => {
    const members = (await listMembers(deps, page.actor, householdId)).map(memberToJson);
    const isOwner = members.some((m) => m.userId === me && m.role === "owner");
    const [balances, settlements, splits, invites, accounts, budgets, categories] =
      await Promise.all([
        getBalances(deps, page.actor, householdId),
        listSettlements(deps, page.actor, householdId, { includeCancelled: true, limit: 50 }),
        listSplits(deps, page.actor, householdId, { limit: 10 }),
        isOwner ? listInvites(deps, page.actor, householdId) : Promise.resolve([]),
        listAccounts(deps, page.actor, householdId),
        listBudgets(deps, page.actor, householdId),
        listCategories(deps, page.actor, householdId, { includeHidden: true }),
      ]);
    return {
      members,
      isOwner,
      balances: balancesToJson(balances),
      settlements: settlements.map(settlementToJson),
      splits: splits.map(splitToJson),
      invites: invites.map(inviteToJson),
      accounts: accounts.accounts.map(accountToJson),
      budgets: budgets.map(budgetToJson),
      categoryName: new Map(categories.map((c) => [c.id, c.name] as const)),
    };
  });
  if (!result.ok) {
    return (
      <>
        <PageHeader title={t.title} usageStats={page.usageStats} />
        <Alert>{t.loadError}</Alert>
      </>
    );
  }
  const v = result.value;
  const name = (id: string) => memberName(id, v.members, me);
  const activeAccounts = v.accounts.filter((a) => !a.archived);
  const commonAccounts = activeAccounts.filter((a) => a.ownerUserId === null);
  const personalAccounts = activeAccounts.filter((a) => a.ownerUserId === me);
  const commonBudgets = v.budgets.filter((b) => b.scope === "household" && !b.archivedAt);
  const personalBudgets = v.budgets.filter((b) => b.scope === "personal" && !b.archivedAt);
  const pairs = v.balances.currencies.flatMap((c) =>
    c.pairs.map((p) => ({ ...p, currency: c.currency })),
  );
  const currencies = v.balances.currencies.map((c) => c.currency);
  const list = (items: readonly string[]) => (items.length > 0 ? items.join(", ") : t.none);

  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={t.title} usageStats={page.usageStats} />
      <div className="flex flex-col gap-4">
        <Card data-testid="family-balances">
          <CardHeader>
            <CardTitle>{t.balancesTitle}</CardTitle>
            <CardDescription>{t.balancesHint}</CardDescription>
          </CardHeader>
          {v.balances.me.some((m) => m.owesMinor > 0 || m.owedMinor > 0) ? (
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="family-me">
              {v.balances.me.map((m) => (
                <Fragment key={m.currency}>
                  <div className="rounded-md bg-surface-2 px-4 py-3">
                    <dt className="text-sm text-muted-foreground">{`${t.youOwe} (${m.currency})`}</dt>
                    <dd
                      className="font-mono text-xl font-semibold tabular-nums"
                      data-testid={`family-owes-${m.currency}`}
                    >
                      {formatMinor(m.owesMinor, m.currency)}
                    </dd>
                  </div>
                  <div className="rounded-md bg-surface-2 px-4 py-3">
                    <dt className="text-sm text-muted-foreground">{`${t.youAreOwed} (${m.currency})`}</dt>
                    <dd
                      className="font-mono text-xl font-semibold tabular-nums"
                      data-testid={`family-owed-${m.currency}`}
                    >
                      {formatMinor(m.owedMinor, m.currency)}
                    </dd>
                  </div>
                </Fragment>
              ))}
            </dl>
          ) : null}
          {pairs.length === 0 ? (
            <p className="text-muted-foreground" data-testid="family-balances-empty">
              {t.balancesEmpty}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border" data-testid="family-pairs">
              {pairs.map((p) => (
                <li
                  key={`${p.currency}-${p.debtorUserId}-${p.creditorUserId}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                  data-testid="family-pair"
                >
                  <span>{t.owes(name(p.debtorUserId), name(p.creditorUserId))}</span>
                  <span className="font-mono font-semibold tabular-nums">
                    {formatMinor(p.amountMinor, p.currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.settlementsTitle}</CardTitle>
            <CardDescription>{t.settlementsHint}</CardDescription>
          </CardHeader>
          {v.members.length > 1 ? (
            <SettlementForm
              members={v.members.map((m) => ({ userId: m.userId, name: name(m.userId) }))}
              meUserId={me}
              isOwner={v.isOwner}
              currencies={currencies.length > 0 ? currencies : ["RON"]}
              suggestion={pairs.find((p) => p.debtorUserId === me) ?? pairs[0] ?? null}
              today={todayIn()}
            />
          ) : null}
          {v.settlements.length === 0 ? (
            <p className="text-muted-foreground">{t.settlementsEmpty}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border" data-testid="family-settlements">
              {v.settlements.map((s) => {
                const party = s.fromUserId === me || s.toUserId === me || s.createdByUserId === me;
                return (
                  <li
                    key={s.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                    data-testid="family-settlement"
                  >
                    <span className={s.cancelledAt ? "text-muted-foreground line-through" : ""}>
                      {t.settlementLine(name(s.fromUserId), name(s.toUserId))} ·{" "}
                      {formatCalendarDate(s.settledOn)}
                      {s.note ? ` · ${s.note}` : ""}
                      {s.cancelledAt ? ` · ${t.cancelled}` : ""}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="font-mono font-semibold tabular-nums">
                        {formatMinor(s.amountMinor, s.currency)}
                      </span>
                      {!s.cancelledAt && party ? <SettlementCancel id={s.id} /> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <MembersPanel
          members={v.members.map((m) => ({
            ...m,
            displayName: name(m.userId),
            // Decontările ACTIVE la care membrul e parte: arătate în dialogul de eliminare (după
            // eliminare nu le mai poate anula; risc acceptat, ADR 0016 §10).
            activeSettlements: v.settlements.filter(
              (s) =>
                s.cancelledAt === null && (s.fromUserId === m.userId || s.toUserId === m.userId),
            ).length,
          }))}
          meUserId={me}
          isOwner={v.isOwner}
        />

        {v.isOwner ? <InvitesPanel invites={v.invites} /> : null}

        <Card>
          <CardHeader>
            <CardTitle>{t.splitsTitle}</CardTitle>
          </CardHeader>
          {v.splits.length === 0 ? (
            <p className="text-muted-foreground">{t.splitsEmpty}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border" data-testid="family-splits">
              {v.splits.map((s) => (
                <li key={s.transactionId} className="flex flex-col gap-1 py-2">
                  <span className="flex flex-wrap justify-between gap-2">
                    <span>{t.paidBy(name(s.payerUserId))}</span>
                    <span className="font-mono font-semibold tabular-nums">
                      {formatMinor(s.totalMinor, s.currency)}
                    </span>
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {s.shares
                      .map((x) => `${name(x.userId)}: ${formatMinor(x.shareMinor, s.currency)}`)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.scopeTitle}</CardTitle>
            <CardDescription>{t.scopeHint}</CardDescription>
          </CardHeader>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted-foreground">{t.commonAccounts}</dt>
              <dd>{list(commonAccounts.map((a) => a.name))}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t.personalAccounts}</dt>
              <dd>{list(personalAccounts.map((a) => a.name))}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t.commonBudgets}</dt>
              <dd>{list(commonBudgets.map((b) => budgetName(b, v.categoryName)))}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t.personalBudgets}</dt>
              <dd>{list(personalBudgets.map((b) => budgetName(b, v.categoryName)))}</dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">{t.receiptsNote}</p>
        </Card>
      </div>
    </>
  );
}
