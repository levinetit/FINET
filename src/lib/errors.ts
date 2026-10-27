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
