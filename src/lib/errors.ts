/**
 * Erori comune, folosite de mai multe module.
 */

/**
 * Funcționalitate declarată, dar neimplementată încă (de exemplu modul `saas` al
 * `entitlements` sau driverul S3 al storage-ului). Se aruncă explicit, ca nimic să nu simuleze
 * un comportament care nu există.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

/**
 * Date de intrare invalide (HTTP 400, `invalid_request`). `fields` are mesaje fixe pe câmp (fără
 * a repeta valoarea primită), ca formatul `{ error: { code, message, fields? } }` din 6.4.
 */
export class ValidationError extends Error {
  readonly code = "invalid_request";
  readonly status = 400;
  constructor(
    readonly fields: Readonly<Record<string, string>> = {},
    message = "Cererea nu e validă.",
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Operația contrazice starea curentă (HTTP 409, `conflict`): de exemplu ștergerea unui cont cu
 * tranzacții sau un nume de cont deja folosit. `reason` e stabil, pentru clienți și teste.
 */
export class ConflictError extends Error {
  readonly code = "conflict";
  readonly status = 409;
  constructor(
    readonly reason: string,
    message = "Operația nu se poate face în starea curentă.",
  ) {
    super(message);
    this.name = "ConflictError";
  }
}
