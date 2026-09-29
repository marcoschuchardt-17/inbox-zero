"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useAction } from "next-safe-action/hooks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { PageWrapper } from "@/components/PageWrapper";
import { Input } from "@/components/Input";
import { toastError, toastSuccess } from "@/components/Toast";
import { getActionErrorMessage } from "@/utils/error";
import {
  testImapSmtpConnectionAction,
  upsertImapSmtpAccountAction,
} from "@/utils/actions/imap-smtp";
import {
  upsertImapSmtpAccountBody,
  type UpsertImapSmtpAccountBody,
} from "@/utils/actions/imap-smtp.validation";

export function ImapAccountForm({
  defaults,
}: {
  defaults: ImapAccountFormDefaults | null;
}) {
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<UpsertImapSmtpAccountBody>({
    resolver: zodResolver(upsertImapSmtpAccountBody),
    defaultValues: formDefaults(defaults),
  });

  const { execute: testConnection, isExecuting: isTesting } = useAction(
    testImapSmtpConnectionAction,
    {
      onSuccess: () => {
        toastSuccess({
          title: "Connection successful",
          description: "IMAP and SMTP are reachable.",
        });
      },
      onError: (error) => {
        toastError({
          title: "Connection failed",
          description: getActionErrorMessage(error.error),
        });
      },
    },
  );

  const { execute: saveAccount, isExecuting: isSaving } = useAction(
    upsertImapSmtpAccountAction,
    {
      onSuccess: ({ data }) => {
        toastSuccess({
          title: "IMAP account saved",
          description: "Your IMAP/SMTP mailbox is now connected.",
        });
        if (!data?.emailAccountId) return;
        window.location.assign(`/${data.emailAccountId}/automation`);
      },
      onError: (error) => {
        toastError({
          title: "Failed to save account",
          description: getActionErrorMessage(error.error),
        });
      },
    },
  );

  return (
    <PageWrapper>
      <PageHeader
        title={defaults ? "Update IMAP/SMTP Account" : "Add IMAP/SMTP Account"}
      />
      <Card className="mt-6 max-w-3xl">
        <CardHeader>
          <CardTitle>Mailbox settings</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={handleSubmit((values) => saveAccount(values))}
          >
            <Input
              type="email"
              name="email"
              label="Email"
              registerProps={{
                ...register("email"),
                readOnly: Boolean(defaults),
              }}
              error={errors.email}
            />
            <Input
              type="text"
              name="name"
              label="Display name (optional)"
              registerProps={register("name")}
              error={errors.name}
            />

            <div className="grid gap-4 md:grid-cols-2">
              <Input
                type="text"
                name="imapHost"
                label="IMAP host"
                registerProps={register("imapHost")}
                error={errors.imapHost}
              />
              <Input
                type="number"
                name="imapPort"
                label="IMAP port"
                registerProps={register("imapPort", { valueAsNumber: true })}
                error={errors.imapPort}
              />
              <Input
                type="text"
                name="imapUsername"
                label="IMAP username"
                registerProps={register("imapUsername")}
                error={errors.imapUsername}
              />
              <Input
                type="password"
                name="imapPassword"
                label="IMAP password"
                registerProps={register("imapPassword")}
                error={errors.imapPassword}
                explainText={
                  defaults
                    ? "Leave blank to keep the saved password."
                    : undefined
                }
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Input
                type="text"
                name="smtpHost"
                label="SMTP host"
                registerProps={register("smtpHost")}
                error={errors.smtpHost}
              />
              <Input
                type="number"
                name="smtpPort"
                label="SMTP port"
                registerProps={register("smtpPort", { valueAsNumber: true })}
                error={errors.smtpPort}
              />
              <Input
                type="text"
                name="smtpUsername"
                label="SMTP username"
                registerProps={register("smtpUsername")}
                error={errors.smtpUsername}
              />
              <Input
                type="password"
                name="smtpPassword"
                label="SMTP password"
                registerProps={register("smtpPassword")}
                error={errors.smtpPassword}
                explainText={
                  defaults
                    ? "Leave blank to keep the saved password."
                    : undefined
                }
              />
            </div>

            <Input
              type="text"
              name="syncFolder"
              label="Sync folder"
              registerProps={register("syncFolder")}
              error={errors.syncFolder}
              explainText="Usually INBOX"
            />

            <div className="flex flex-wrap gap-6 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" {...register("imapSecure")} />
                IMAP TLS
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" {...register("smtpSecure")} />
                SMTP TLS
              </label>
            </div>
            <p className="text-sm text-muted-foreground">
              Leave TLS on for ports 993 and 465. Turn it off for STARTTLS on
              ports 143 and 587.
            </p>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                loading={isTesting}
                disabled={isSaving}
                onClick={() => {
                  const values = getValues();
                  testConnection({
                    emailAccountId: defaults?.emailAccountId,
                    imapHost: values.imapHost,
                    imapPort: values.imapPort,
                    imapSecure: values.imapSecure,
                    imapUsername: values.imapUsername,
                    imapPassword: values.imapPassword,
                    smtpHost: values.smtpHost,
                    smtpPort: values.smtpPort,
                    smtpSecure: values.smtpSecure,
                    smtpUsername: values.smtpUsername,
                    smtpPassword: values.smtpPassword,
                    syncFolder: values.syncFolder,
                  });
                }}
              >
                Test connection
              </Button>
              <Button type="submit" loading={isSaving} disabled={isTesting}>
                Save account
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </PageWrapper>
  );
}

export type ImapAccountFormDefaults = {
  emailAccountId: string;
  email: string;
  name: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUsername: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  syncFolder: string;
};

function formDefaults(
  defaults: ImapAccountFormDefaults | null,
): UpsertImapSmtpAccountBody {
  return {
    email: defaults?.email ?? "",
    name: defaults?.name ?? "",
    imapHost: defaults?.imapHost ?? "",
    imapPort: defaults?.imapPort ?? 993,
    imapSecure: defaults?.imapSecure ?? true,
    imapUsername: defaults?.imapUsername ?? "",
    imapPassword: "",
    smtpHost: defaults?.smtpHost ?? "",
    smtpPort: defaults?.smtpPort ?? 465,
    smtpSecure: defaults?.smtpSecure ?? true,
    smtpUsername: defaults?.smtpUsername ?? "",
    smtpPassword: "",
    syncFolder: defaults?.syncFolder ?? "INBOX",
  };
}
