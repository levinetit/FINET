import { describe, expect, it } from "vitest";

import { createMailer, smtpTransportOptions } from "./mailer";

const smtp = (port: number) => ({
  host: "smtp.exemplu.invalid",
  port,
  user: "finet",
  password: "parola-fictiva",
  from: "FINET <finet@exemplu.invalid>",
});

describe("opțiunile SMTP (L4)", () => {
  it("în producție TLS e obligatoriu pe orice port (implicit pe 465, STARTTLS altfel)", () => {
    for (const port of [25, 587, 2525, 1025]) {
      const o = smtpTransportOptions(smtp(port), true);
      expect(o.secure, String(port)).toBe(false);
      expect(o.requireTLS, String(port)).toBe(true);
    }
    const tls = smtpTransportOptions(smtp(465), true);
    expect(tls.secure).toBe(true);
    expect(tls.requireTLS).toBe(false);
    expect(tls.tls).toEqual({ rejectUnauthorized: true, minVersion: "TLSv1.2" });
  });

  it("în dezvoltare doar 587 cere STARTTLS (serverul local pe 1025 nu are TLS)", () => {
    expect(smtpTransportOptions(smtp(1025), false).requireTLS).toBe(false);
    expect(smtpTransportOptions(smtp(587), false).requireTLS).toBe(true);
    expect(smtpTransportOptions(smtp(465), false).secure).toBe(true);
  });

  it("fără SMTP nu există mailer; fără utilizator nu se trimite autentificare", () => {
    expect(createMailer(null)).toBeNull();
    expect(smtpTransportOptions({ ...smtp(587), user: null }, true).auth).toBeUndefined();
  });
});
