import { APP_URL, type AuthEnv, login } from "@/modules/auth/testing";
import { OPERATIONS } from "@/openapi/registry";
import { errorSchema } from "@/openapi/schemas";

import * as L from "./ledger-handlers";
import * as M from "./me-handlers";

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
]);

/** Aruncă dacă răspunsul nu respectă contractul operației handlerului. */
export async function assertContract(handler: unknown, response: Response): Promise<void> {
  const id = OPERATION_OF.get(handler);
  if (!id) throw new Error("handler fără operație în registrul OpenAPI");
  const op = OPERATIONS.find((o) => o.operationId === id)!;
  const text = await response.clone().text();
  if (response.status === op.success.status) {
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
