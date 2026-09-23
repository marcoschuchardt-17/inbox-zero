import { z } from "zod";

const hostSchema = z
  .string()
  .trim()
  .min(1, "Host is required")
  .max(255, "Host is too long");

const portSchema = z.coerce
  .number()
  .int("Port must be an integer")
  .min(1, "Port must be between 1 and 65535")
  .max(65_535, "Port must be between 1 and 65535");

const credentialSchema = z
  .string()
  .trim()
  .min(1, "This field is required")
  .max(512, "Value is too long");

export const upsertImapSmtpAccountBody = z.object({
  email: z.string().trim().email("Enter a valid email"),
  name: z.string().trim().max(120).optional(),
  imapHost: hostSchema,
  imapPort: portSchema.default(993),
  imapSecure: z.boolean().default(true),
  imapUsername: credentialSchema,
  imapPassword: credentialSchema,
  smtpHost: hostSchema,
  smtpPort: portSchema.default(465),
  smtpSecure: z.boolean().default(true),
  smtpUsername: credentialSchema,
  smtpPassword: credentialSchema,
  syncFolder: z.string().trim().min(1).max(255).default("INBOX"),
});
export type UpsertImapSmtpAccountBody = z.infer<
  typeof upsertImapSmtpAccountBody
>;

export const testImapSmtpConnectionBody = upsertImapSmtpAccountBody.omit({
  email: true,
  name: true,
});
export type TestImapSmtpConnectionBody = z.infer<
  typeof testImapSmtpConnectionBody
>;
