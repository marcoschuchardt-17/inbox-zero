import {
  addressesOtherThanAccount,
  extractEmailAddresses,
  isSameEmailAddress,
} from "@/utils/email";
import prisma from "@/utils/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { Logger } from "@/utils/logger";

export type SenderEmailStats = {
  from: string;
  fromName: string | null;
  minFromName: string | null;
  count: number;
  inboxEmails: number;
  readEmails: number;
  unsubscribeLink: string | null;
};

export type SenderEmailStatsOptions = {
  emailAccountId: string;
  /** Unix timestamp in milliseconds */
  fromDate?: number | null;
  /** Unix timestamp in milliseconds */
  toDate?: number | null;
  read?: boolean;
  unread?: boolean;
  archived?: boolean;
  unarchived?: boolean;
  search?: string;
  orderBy?: "emails" | "unread" | "unarchived";
  orderDirection?: "asc" | "desc";
  limit?: number | null;
  accountEmail?: string | null;
  logger: Logger;
};

/**
 * Aggregates per-sender email stats from the EmailMessage table.
 * Powers the bulk unsubscribe page and the inbox health email.
 */
export async function getSenderEmailStats(
  options: SenderEmailStatsOptions,
): Promise<SenderEmailStats[]> {
  const { logger } = options;
  // Build WHERE conditions using Prisma.sql for type safety
  const whereConditions: Prisma.Sql[] = [];

  // Add date filters if provided
  if (options.fromDate) {
    const fromTimestamp = (options.fromDate / 1000).toString();
    whereConditions.push(
      Prisma.sql`"date" >= to_timestamp(${fromTimestamp}::double precision)`,
    );
  }

  if (options.toDate) {
    const toTimestamp = (options.toDate / 1000).toString();
    whereConditions.push(
      Prisma.sql`"date" <= to_timestamp(${toTimestamp}::double precision)`,
    );
  }

  // Add read/unread filters
  if (options.read) {
    whereConditions.push(Prisma.sql`read = true`);
  } else if (options.unread) {
    whereConditions.push(Prisma.sql`read = false`);
  }

  // Add inbox/archived filters
  if (options.unarchived) {
    whereConditions.push(Prisma.sql`inbox = true`);
  } else if (options.archived) {
    whereConditions.push(Prisma.sql`inbox = false`);
  }

  // Always filter by emailAccountId
  whereConditions.push(
    Prisma.sql`"emailAccountId" = ${options.emailAccountId}`,
  );
  // Sent and draft rows are mail this account wrote. These stats list people
  // who wrote to the account, for bulk unsubscribe and inbox health.
  whereConditions.push(Prisma.sql`sent = false`);
  whereConditions.push(Prisma.sql`draft = false`);

  // Add search filter if provided - search both from (email) and fromName fields
  if (options.search) {
    const searchTerm = options.search.toLowerCase();
    whereConditions.push(
      Prisma.sql`(position(${searchTerm} in LOWER("from")) > 0 OR position(${searchTerm} in LOWER(COALESCE("fromName", ''))) > 0)`,
    );
  }

  // Join conditions with AND
  const whereClause =
    whereConditions.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")}`
      : Prisma.empty;

  // Build order by clause (safe, no user input)
  const orderByClause = options.orderBy
    ? getOrderByClause(options.orderBy, options.orderDirection)
    : '"count" DESC';

  // Build limit clause (safe, validated number)
  const limitClause = options.limit ? `LIMIT ${options.limit}` : "";

  // Build the complete query using Prisma.sql
  const query = Prisma.sql`
    WITH email_message_stats AS (
      SELECT
        LOWER("from") AS "from",
        MAX(NULLIF("fromName", '')) as "fromName",
        MIN(NULLIF("fromName", '')) as "minFromName",
        COUNT(*)::int as "count",
        SUM(CASE WHEN inbox = true THEN 1 ELSE 0 END)::int as "inboxEmails",
        SUM(CASE WHEN read = true THEN 1 ELSE 0 END)::int as "readEmails",
        MAX("unsubscribeLink") as "unsubscribeLink"
      FROM "EmailMessage"
      ${whereClause}
      GROUP BY LOWER("from")
    )
    SELECT * FROM email_message_stats
    ORDER BY ${Prisma.raw(orderByClause)}
    ${Prisma.raw(limitClause)}
  `;

  try {
    const results = await prisma.$queryRaw<SenderEmailStats[]>(query);

    return expandSenderAddresses(results, options.accountEmail);
  } catch (error) {
    logger.error("getSenderEmailStats error", {
      error,
      errorStack: error instanceof Error ? error.stack : undefined,
    });
    return [];
  }
}

function getOrderByClause(
  orderBy: string,
  orderDirection?: "asc" | "desc",
): string {
  const direction = orderDirection?.toUpperCase() || "DESC";

  switch (orderBy) {
    case "emails":
      return `"count" ${direction}`;
    case "unread":
      // Sort by read percentage (lower = more unread)
      return `"readEmails"::float / NULLIF("count", 0) ${direction}`;
    case "unarchived":
      // Sort by archived percentage (lower = more in inbox)
      return `("count" - "inboxEmails")::float / NULLIF("count", 0) ${direction}`;
    default:
      return `"count" ${direction}`;
  }
}

function expandSenderAddresses(
  results: SenderEmailStats[],
  accountEmail?: string | null,
) {
  const merged = new Map<string, SenderEmailStats>();
  for (const result of results) {
    const addresses = extractEmailAddresses(result.from).map((address) =>
      address.toLowerCase(),
    );
    const people = addressesOtherThanAccount(
      addresses.length ? addresses : [result.from],
      accountEmail,
    );
    if (!people.length) continue;
    for (const address of people) {
      const fromName =
        people.length === 1 &&
        (!addresses.length || isSameEmailAddress(addresses[0], address))
          ? result.fromName
          : null;
      const existing = merged.get(address);
      if (!existing) {
        merged.set(address, {
          from: address,
          fromName,
          minFromName: fromName ? result.minFromName : null,
          count: asNumber(result.count),
          inboxEmails: asNumber(result.inboxEmails),
          readEmails: asNumber(result.readEmails),
          unsubscribeLink: result.unsubscribeLink,
        });
        continue;
      }
      existing.count += asNumber(result.count);
      existing.inboxEmails += asNumber(result.inboxEmails);
      existing.readEmails += asNumber(result.readEmails);
      if (!existing.unsubscribeLink && result.unsubscribeLink) {
        existing.unsubscribeLink = result.unsubscribeLink;
      }
    }
  }
  return [...merged.values()].sort(
    (left, right) =>
      right.count - left.count || left.from.localeCompare(right.from),
  );
}

function asNumber(value: number | bigint) {
  return typeof value === "bigint" ? Number(value) : value;
}
