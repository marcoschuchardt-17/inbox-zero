-- CreateTable
CREATE TABLE "ImapSmtpConfig" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL,
    "imapSecure" BOOLEAN NOT NULL DEFAULT true,
    "imapUsername" TEXT NOT NULL,
    "imapPassword" TEXT NOT NULL,
    "smtpHost" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL,
    "smtpSecure" BOOLEAN NOT NULL DEFAULT true,
    "smtpUsername" TEXT NOT NULL,
    "smtpPassword" TEXT NOT NULL,
    "syncFolder" TEXT NOT NULL DEFAULT 'INBOX',
    "lastSyncUid" BIGINT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastConnectionError" TEXT,

    CONSTRAINT "ImapSmtpConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImapSmtpConfig_emailAccountId_key" ON "ImapSmtpConfig"("emailAccountId");

-- AddForeignKey
ALTER TABLE "ImapSmtpConfig" ADD CONSTRAINT "ImapSmtpConfig_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
