"use client";

import { useRouter } from "next/navigation";
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

export default function AddImapAccountPage() {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<UpsertImapSmtpAccountBody>({
    resolver: zodResolver(upsertImapSmtpAccountBody),
    defaultValues: {
      imapPort: 993,
      smtpPort: 465,
      imapSecure: true,
      smtpSecure: true,
      syncFolder: "INBOX",
    },
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
      onSuccess: () => {
        toastSuccess({
          title: "IMAP account saved",
          description: "Your IMAP/SMTP mailbox is now connected.",
        });
        router.push("/accounts");
        router.refresh();
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
      <PageHeader title="Add IMAP/SMTP Account" />
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
              registerProps={register("email")}
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

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                loading={isTesting}
                disabled={isSaving}
                onClick={() => {
                  const values = getValues();
                  testConnection({
                    imapHost: values.imapHost,
                    imapPort: values.imapPort,
                    imapSecure: true,
                    imapUsername: values.imapUsername,
                    imapPassword: values.imapPassword,
                    smtpHost: values.smtpHost,
                    smtpPort: values.smtpPort,
                    smtpSecure: true,
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
