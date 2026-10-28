import { z } from "zod";

/** `POST /api/v1/me/password`: parola curentă + parola nouă (politica se aplică în serviciu). */
export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(512),
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
