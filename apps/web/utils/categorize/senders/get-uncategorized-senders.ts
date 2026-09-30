import {
  addressesOtherThanAccount,
  extractEmailAddresses,
  isSameEmailAddress,
} from "@/utils/email";
import { getSenders } from "./get-senders";
import prisma from "@/utils/prisma";
import type { Sender } from "@/utils/categorize/senders/batch-validation";

const MAX_ITERATIONS = 200;

export async function getUncategorizedSenders({
  emailAccountId,
  offset = 0,
  limit = 100,
}: {
  emailAccountId: string;
  offset?: number;
  limit?: number;
}) {
  let uncategorizedSenders: Sender[] = [];
  let currentOffset = offset;
  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { email: true },
  });

  while (uncategorizedSenders.length === 0 && currentOffset < MAX_ITERATIONS) {
    const result = await getSenders({
      emailAccountId,
      limit,
      offset: currentOffset,
    });

    const senderMap = new Map<string, string | null>();
    for (const sender of result) {
      const addresses = extractEmailAddresses(sender.from);
      const people = addressesOtherThanAccount(
        addresses.length ? addresses : [sender.from],
        account?.email,
      );
      if (!people.length) continue;
      for (const email of people) {
        const name = senderNameForAddress(
          sender.fromName,
          addresses,
          people,
          email,
        );
        if (!senderMap.has(email) || (!senderMap.get(email) && name)) {
          senderMap.set(email, name);
        }
      }
    }

    const allSenderEmails = Array.from(senderMap.keys());

    const existingSenders = await prisma.newsletter.findMany({
      where: {
        email: { in: allSenderEmails },
        emailAccountId,
        category: { isNot: null },
      },
      select: { email: true },
    });

    const existingSenderEmails = new Set(existingSenders.map((s) => s.email));

    uncategorizedSenders = allSenderEmails
      .filter((email) => !existingSenderEmails.has(email))
      .map((email) => ({ email, name: senderMap.get(email) ?? null }));

    // Use result.length (raw query count) not allSenderEmails.length (de-duplicated count)
    // to correctly detect when there are more pages
    if (result.length < limit) {
      return { uncategorizedSenders };
    }

    currentOffset += limit;
  }

  // Only return nextOffset if we found senders (to avoid infinite loop when MAX_ITERATIONS is hit)
  if (uncategorizedSenders.length > 0) {
    return { uncategorizedSenders, nextOffset: currentOffset };
  }
  return { uncategorizedSenders };
}

function senderNameForAddress(
  fromName: string | null,
  addresses: string[],
  people: string[],
  email: string,
) {
  if (
    people.length === 1 &&
    (!addresses.length || isSameEmailAddress(addresses[0] || "", email))
  ) {
    return fromName;
  }
  return null;
}
