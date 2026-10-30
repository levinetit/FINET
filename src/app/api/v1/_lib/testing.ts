import { APP_URL, type AuthEnv, login } from "@/modules/auth/testing";
import { OPERATIONS } from "@/openapi/registry";
import { errorSchema } from "@/openapi/schemas";

import * as A from "./app-handlers";
import * as L from "./ledger-handlers";
import * as M from "./me-handlers";
import * as P from "./planning-handlers";
import * as D from "./documents-handlers";
import * as F from "./family-handlers";
import * as G from "./gdpr-handlers";
import * as RC from "./receipts-handlers";
import * as R from "./recurring-handlers";
import * as S from "./statements-handlers";
import * as MT from "./matching-handlers";
import * as SH from "./shopping-handlers";
import * as AD from "./admin-handlers";
import * as RG from "./register-handlers";
import * as AH from "./ask-handlers";
import * as SM from "./summary-handlers";
import * as PR from "./prices-handlers";

/**
 * Doar pentru testele de integrare ale API-ului `/api/v1`: construirea cererilor și sesiunile de
 * test (cookie web și bearer mobil). Nu se importă din codul aplicației.
 */

export type ApiJson = Record<string, unknown> & {
  data?: unknown;
  nextCursor?: string | null;
  error?: { code: string; message: string; fields?: Record<string, string>; reason?: string };
};

export type ApiInit = {
  method?: string;
  body?: unknown;
  rawBody?: string;
  cookie?: string;
  bearer?: string;
  headers?: Record<string, string>;
};

export function apiRequest(path: string, init: ApiInit = {}): Request {
  const headers: Record<string, string> = {};
  if (init.cookie) {
    headers.cookie = init.cookie;
    headers.origin = APP_URL;
  }
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  Object.assign(headers, init.headers);
  for (const [k, v] of Object.entries(headers)) if (v === "") delete headers[k];
  const body = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  return new Request(`${APP_URL}${path}`, {
    method: init.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
  });
}

export const readJson = async (r: Response): Promise<ApiJson> => {
  const text = await r.text();
  return (text ? JSON.parse(text) : {}) as ApiJson;
};

export type Sessions = Readonly<{ cookie: string; bearer: string }>;

/** O sesiune web (cookie) și una mobilă (bearer) pentru același utilizator. */
export async function sessionsFor(
  env: AuthEnv,
  email: string,
  password: string,
): Promise<Sessions> {
  const web = await login(env, email, password);
  const mobile = await login(env, email, password, { "x-finet-client": "android/1.0" });
  if (!web.cookie || !mobile.bearer) throw new Error("login de test eșuat");
  return { cookie: web.cookie, bearer: mobile.bearer };
}

// ---------------------------------------------------------------------------------------------
// Contractul: fiecare răspuns real al unui handler se verifică față de schema din registrul
// OpenAPI (succes: schema operației; eroare: `Error`), ca documentația să nu se depărteze de cod.
// ---------------------------------------------------------------------------------------------

const OPERATION_OF = new Map<unknown, string>([
  [L.listHouseholdsHandler, "listHouseholds"],
  [L.getHouseholdHandler, "getHousehold"],
  [L.listAccountsHandler, "listAccounts"],
  [L.createAccountHandler, "createAccount"],
  [L.getAccountHandler, "getAccount"],
  [L.patchAccountHandler, "patchAccount"],
  [L.deleteAccountHandler, "deleteAccount"],
  [L.archiveAccountHandler, "archiveAccount"],
  [L.listCategoriesHandler, "listCategories"],
  [L.createCategoryHandler, "createCategory"],
  [L.getCategoryHandler, "getCategory"],
  [L.patchCategoryHandler, "patchCategory"],
  [L.deleteCategoryHandler, "deleteCategory"],
  [L.setCategoryHiddenHandler, "hideCategory"],
  [L.listTransactionsHandler, "listTransactions"],
  [L.createTransactionHandler, "createTransaction"],
  [L.getTransactionHandler, "getTransaction"],
  [L.patchTransactionHandler, "patchTransaction"],
  [L.deleteTransactionHandler, "deleteTransaction"],
  [L.createTransferHandler, "createTransfer"],
  [L.getTransferHandler, "getTransfer"],
  [L.patchTransferHandler, "patchTransfer"],
  [L.deleteTransferHandler, "deleteTransfer"],
  [M.getMeHandler, "getMe"],
  [M.patchMeHandler, "patchMe"],
  [M.changePasswordHandler, "changePassword"],
  [M.listSessionsHandler, "listSessions"],
  [M.deleteSessionHandler, "revokeSession"],
  [M.revokeOthersHandler, "revokeOtherSessions"],
  [M.getConsentsHandler, "getConsents"],
  [M.putConsentsHandler, "putConsents"],
  [M.appEventsHandler, "postAppEvents"],
  [A.androidLatestHandler, "getAndroidLatest"],
  [P.listTagsHandler, "listTags"],
  [P.createTagHandler, "createTag"],
  [P.getTagHandler, "getTag"],
  [P.patchTagHandler, "patchTag"],
  [P.deleteTagHandler, "deleteTag"],
  [P.listBudgetsHandler, "listBudgets"],
  [P.createBudgetHandler, "createBudget"],
  [P.budgetStatusHandler, "getBudgetStatus"],
  [P.getBudgetHandler, "getBudget"],
  [P.patchBudgetHandler, "patchBudget"],
  [P.deleteBudgetHandler, "deleteBudget"],
  [P.listGoalsHandler, "listGoals"],
  [P.createGoalHandler, "createGoal"],
  [P.getGoalHandler, "getGoal"],
  [P.patchGoalHandler, "patchGoal"],
  [P.deleteGoalHandler, "deleteGoal"],
  [P.contributeGoalHandler, "contributeGoal"],
  [P.abandonGoalHandler, "abandonGoal"],
  [P.dashboardHandler, "getDashboard"],
  [P.monthlyReportHandler, "getMonthlyReport"],
  [P.exportTransactionsHandler, "exportTransactionsCsv"],
  [P.exportGoalsHandler, "exportGoalsCsv"],
  [P.exportBudgetsHandler, "exportBudgetsCsv"],
  [P.exportTransactionsXlsxHandler, "exportTransactionsXlsx"],
  [P.exportTransactionsPdfHandler, "exportTransactionsPdf"],
  [P.exportGoalsXlsxHandler, "exportGoalsXlsx"],
  [P.exportGoalsPdfHandler, "exportGoalsPdf"],
  [P.exportBudgetsXlsxHandler, "exportBudgetsXlsx"],
  [P.exportBudgetsPdfHandler, "exportBudgetsPdf"],
  [P.exportAccountingCsvHandler, "exportAccountingCsv"],
  [P.exportAccountingXlsxHandler, "exportAccountingXlsx"],
  [P.exportReceiptsXlsxHandler, "exportReceiptsXlsx"],
  [P.exportReceiptsPdfHandler, "exportReceiptsPdf"],
  [R.listRecurringHandler, "listRecurring"],
  [R.createRecurringHandler, "createRecurring"],
  [R.recurringSummaryHandler, "getRecurringSummary"],
  [R.generateRecurringHandler, "generateRecurring"],
  [R.getRecurringHandler, "getRecurring"],
  [R.patchRecurringHandler, "patchRecurring"],
  [R.deleteRecurringHandler, "deleteRecurring"],
  [R.pauseRecurringHandler, "pauseRecurring"],
  [R.resumeRecurringHandler, "resumeRecurring"],
  [D.uploadDocumentsHandler, "uploadDocuments"],
  [D.listDocumentsHandler, "listDocuments"],
  [D.getDocumentHandler, "getDocument"],
  [D.deleteDocumentHandler, "deleteDocument"],
  [D.documentFileHandler, "getDocumentFile"],
  [D.aiUsageHandler, "getAiUsage"],
  [RC.listReceiptsHandler, "listReceipts"],
  [RC.getReceiptHandler, "getReceipt"],
  [RC.patchReceiptHandler, "patchReceipt"],
  [RC.deleteReceiptHandler, "deleteReceipt"],
  [RC.confirmReceiptHandler, "confirmReceipt"],
  [RC.reprocessReceiptHandler, "reprocessReceipt"],
  [F.setActiveHouseholdHandler, "setActiveHousehold"],
  [F.listMembersHandler, "listFamilyMembers"],
  [F.patchMemberHandler, "patchFamilyMember"],
  [F.deleteMemberHandler, "removeFamilyMember"],
  [F.transferOwnershipHandler, "transferFamilyOwnership"],
  [F.leaveHouseholdHandler, "leaveHousehold"],
  [F.listInvitesHandler, "listInvites"],
  [F.createInviteHandler, "createInvite"],
  [F.revokeInviteHandler, "revokeInvite"],
  [F.acceptInviteHandler, "acceptInvite"],
  [F.balancesHandler, "getFamilyBalances"],
  [F.listSettlementsHandler, "listSettlements"],
  [F.createSettlementHandler, "createSettlement"],
  [F.cancelSettlementHandler, "cancelSettlement"],
  [F.listSplitsHandler, "listSplits"],
  [F.getSplitHandler, "getTransactionSplit"],
  [F.putSplitHandler, "putTransactionSplit"],
  [F.deleteSplitHandler, "deleteTransactionSplit"],
  [F.eventsHandler, "getLiveEvents"],
  [S.uploadStatementHandler, "uploadStatement"],
  [S.listUploadsHandler, "listStatementUploads"],
  [S.getUploadHandler, "getStatementUpload"],
  [S.cancelUploadHandler, "cancelStatementUpload"],
  [S.listImportsHandler, "listStatementImports"],
  [S.getImportHandler, "getStatementImport"],
  [S.discardImportHandler, "discardStatementPreview"],
  [S.confirmImportHandler, "confirmStatementImport"],
  [S.cancelImportHandler, "cancelStatementImport"],
  [S.coverageHandler, "getStatementCoverage"],
  [MT.receiptMatchesHandler, "getReceiptMatches"],
  [MT.decideMatchHandler, "decideReceiptMatch"],
  [MT.matchQueueHandler, "listMatchQueue"],
  [MT.listSuggestionsHandler, "listRecurringSuggestions"],
  [MT.acceptSuggestionHandler, "acceptRecurringSuggestion"],
  [MT.dismissSuggestionHandler, "dismissRecurringSuggestion"],
  [G.dataExportHandler, "exportMyData"],
  [G.deletionPreviewHandler, "getDeletionPreview"],
  [G.deleteAccountHandler, "deleteMyAccount"],
  [G.usageStatsHandler, "getUsageStats"],
  [SH.listShoppingListsHandler, "listShoppingLists"],
  [SH.createShoppingListHandler, "createShoppingList"],
  [SH.shoppingSuggestionsHandler, "getShoppingSuggestions"],
  [SH.shoppingReceiptsHandler, "listShoppingReceipts"],
  [SH.getShoppingListHandler, "getShoppingList"],
  [SH.patchShoppingListHandler, "patchShoppingList"],
  [SH.deleteShoppingListHandler, "deleteShoppingList"],
  [SH.copyShoppingListHandler, "copyShoppingList"],
  [SH.reorderShoppingItemsHandler, "reorderShoppingItems"],
  [SH.addShoppingItemHandler, "addShoppingItem"],
  [SH.patchShoppingItemHandler, "patchShoppingItem"],
  [SH.deleteShoppingItemHandler, "deleteShoppingItem"],
  [SH.matchShoppingItemHandler, "matchShoppingItem"],
  [SH.runShoppingComparisonHandler, "runShoppingComparison"],
  [SH.getShoppingComparisonHandler, "getShoppingComparison"],
  [PR.productsHandler, "listProductPrices"],
  [PR.seriesHandler, "getPriceSeries"],
  [PR.inflationHandler, "getPersonalInflation"],
  [PR.listReportDefinitionsHandler, "listReportDefinitions"],
  [PR.createReportDefinitionHandler, "createReportDefinition"],
  [PR.previewReportHandler, "previewReportRules"],
  [AH.askHandler, "askFinet"],
  [RG.registerHandler, "registerAccount"],
  [RG.completeRegisterHandler, "completeRegistration"],
  [AD.createFeedbackHandler, "createFeedback"],
  [AD.listAnnouncementsHandler, "listAnnouncements"],
  [AD.reportErrorHandler, "reportError"],
  [AD.adminUsersHandler, "adminListUsers"],
  [AD.adminSetUserStatusHandler, "adminSetUserStatus"],
  [AD.adminHouseholdsHandler, "adminListHouseholds"],
  [AD.adminJobsHandler, "adminListJobs"],
  [AD.adminFeedbackHandler, "adminListFeedback"],
  [AD.adminSetFeedbackStatusHandler, "adminSetFeedbackStatus"],
  [AD.adminAnnouncementsHandler, "adminListAnnouncements"],
  [AD.adminCreateAnnouncementHandler, "adminCreateAnnouncement"],
  [AD.adminUpdateAnnouncementHandler, "adminUpdateAnnouncement"],
  [AD.adminErrorsHandler, "adminListErrors"],
  [SM.monthlySummaryHandler, "getMonthlySummary"],
  [PR.getReportDefinitionHandler, "getReportDefinition"],
  [PR.patchReportDefinitionHandler, "patchReportDefinition"],
  [PR.deleteReportDefinitionHandler, "deleteReportDefinition"],
  [PR.runReportHandler, "runReportDefinition"],
  [PR.exportReportHandler, "exportReportDefinitionCsv"],
]);

/** Antetele obligatorii ale unui export CSV (F3-B). */
function assertCsvHeaders(id: string, response: Response): void {
  const h = response.headers;
  const problems = [
    h.get("content-type") === "text/csv; charset=utf-8" ? null : "content-type",
    /^attachment; filename="finet-[a-z]+\.csv"$/.test(h.get("content-disposition") ?? "")
      ? null
      : "content-disposition",
    h.get("cache-control") === "no-store" ? null : "cache-control",
    h.get("x-content-type-options") === "nosniff" ? null : "x-content-type-options",
  ].filter((x) => x !== null);
  if (problems.length > 0) throw new Error(`${id}: antete CSV greșite: ${problems.join(", ")}`);
}

/** Aruncă dacă răspunsul nu respectă contractul operației handlerului. */
export async function assertContract(handler: unknown, response: Response): Promise<void> {
  const id = OPERATION_OF.get(handler);
  if (!id) throw new Error("handler fără operație în registrul OpenAPI");
  const op = OPERATIONS.find((o) => o.operationId === id)!;
  if (response.status === op.success.status && op.success.csv) {
    assertCsvHeaders(id, response);
    // `Response.text()` elimină BOM-ul: se verifică octeții (EF BB BF).
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    if (bytes[0] !== 0xef || bytes[1] !== 0xbb || bytes[2] !== 0xbf) {
      throw new Error(`${id}: CSV fără BOM`);
    }
    return;
  }
  if (response.status === op.success.status && op.success.binary) {
    const h = response.headers;
    const problems = [
      op.success.binary.includes(h.get("content-type") ?? "") ? null : "content-type",
      /^attachment; filename="(bon-[0-9a-f-]{36}\.(jpg|png|webp|pdf)|finet-export\.zip|finet-[a-z]+\.(xlsx|pdf))"$/.test(
        h.get("content-disposition") ?? "",
      )
        ? null
        : "content-disposition",
      h.get("x-content-type-options") === "nosniff" ? null : "x-content-type-options",
      /no-store/.test(h.get("cache-control") ?? "") ? null : "cache-control",
    ].filter((x) => x !== null);
    if (problems.length > 0) throw new Error(`${id}: antete greșite: ${problems.join(", ")}`);
    return;
  }
  if (response.status === op.success.status && op.success.sse) {
    // Fluxul SSE nu se citește aici (nu se termină): doar antetele obligatorii (ADR 0017).
    const h = response.headers;
    const problems = [
      (h.get("content-type") ?? "").startsWith("text/event-stream") ? null : "content-type",
      /no-transform/.test(h.get("cache-control") ?? "") ? null : "cache-control",
      /no-store/.test(h.get("cache-control") ?? "") ? null : "no-store",
    ].filter((x) => x !== null);
    if (problems.length > 0) throw new Error(`${id}: antete SSE greșite: ${problems.join(", ")}`);
    return;
  }
  const text = await response.clone().text();
  if (response.status === op.success.status || response.status === op.success.alsoStatus) {
    if (op.success.schema === null) {
      if (text !== "") throw new Error(`${id}: ${response.status} trebuia să fie fără corp`);
      return;
    }
    const parsed = op.success.schema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(
        `${id}: răspunsul nu respectă schema: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    return;
  }
  const declared = new Set([...op.errors, 401, 429, 500]);
  if (!declared.has(response.status)) {
    throw new Error(`${id}: status ${response.status} nedocumentat în OpenAPI`);
  }
  const parsed = errorSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${id}: eroare în alt format: ${text.slice(0, 200)}`);
}
