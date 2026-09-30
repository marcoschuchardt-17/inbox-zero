import {
  addressesOtherThanAccount,
  extractDomainFromEmail,
  extractEmailAddresses,
} from "@/utils/email";
import prisma from "@/utils/prisma";

type EmailField = "to" | "from" | "fromDomain";

interface EmailFieldStatsResult {
  data: Array<{
    to?: string;
    from?: string;
    count: number;
  }>;
}

/**
 * Get detailed email stats for a specific field
 */
export async function getEmailFieldStats({
  emailAccountId,
  fromDate,
  toDate,
  field,
  isSent,
  accountEmail,
}: {
  emailAccountId: string;
  fromDate?: number | null;
  toDate?: number | null;
  field: EmailField;
  isSent: boolean;
  accountEmail?: string | null;
}): Promise<EmailFieldStatsResult> {
  const dateRange = { fromDate, toDate };
  const sourceField = field === "fromDomain" ? "from" : field;
  const emailsCount = await prisma.emailMessage.groupBy({
    by: [sourceField],
    where: {
      emailAccountId,
      sent: isSent,
      date: {
        gte: dateRange.fromDate ? new Date(dateRange.fromDate) : undefined,
        lte: dateRange.toDate ? new Date(dateRange.toDate) : undefined,
      },
    },
    _count: {
      [sourceField]: true,
    },
    orderBy: {
      _count: {
        [sourceField]: "desc",
      },
    },
  });

  const rows = emailsCount.map((item) => ({
    value: String(item[sourceField] || ""),
    count: item._count[sourceField] ?? 0,
  }));
  const exceptAccount =
    !isSent && (field === "from" || field === "fromDomain")
      ? accountEmail
      : undefined;
  const counted =
    field === "fromDomain"
      ? countAddressDomains(rows, exceptAccount)
      : countAddresses(rows, exceptAccount);
  const resultField = field === "fromDomain" ? "from" : field;

  return {
    data: counted.slice(0, 50).map((item) => ({
      [resultField]: item.value,
      count: item.count,
    })),
  };
}

export function countAddresses(
  rows: AddressCount[],
  accountEmail?: string | null,
) {
  return rankedCounts(rows, (value) =>
    addressesOtherThanAccount(addressesInStoredField(value), accountEmail),
  );
}

export function countAddressDomains(
  rows: AddressCount[],
  accountEmail?: string | null,
) {
  return rankedCounts(rows, (value) =>
    addressesOtherThanAccount(
      addressesInStoredField(value),
      accountEmail,
    ).flatMap((address) => {
      const domain = extractDomainFromEmail(address).toLowerCase();
      return domain ? [domain] : [];
    }),
  );
}

type AddressCount = { value: string; count: number };

function addressesInStoredField(value: string) {
  const addresses = extractEmailAddresses(value).map((address) =>
    address.toLowerCase(),
  );
  if (addresses.length) return addresses;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? [trimmed] : [];
}

function rankedCounts(
  rows: AddressCount[],
  valuesFor: (value: string) => string[],
) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const value of valuesFor(row.value)) {
      counts.set(value, (counts.get(value) ?? 0) + row.count);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.value.localeCompare(right.value),
    );
}
