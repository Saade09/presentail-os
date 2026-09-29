import { clerkClient } from "@clerk/express";
import { logger } from "./logger";

/**
 * Provision (or update) a Clerk user for a driver phone number.
 *
 * - Searches for an existing Clerk user by phone number (E.164).
 * - If found, updates their publicMetadata and privateMetadata.
 * - If not found, creates a new Clerk user with phone as primary identifier.
 * - Always sets publicMetadata.userType = "driver" and
 *   privateMetadata.driverId = <driverId>.
 *
 * Returns the Clerk user ID (string). Throws on Clerk API error.
 */
export async function syncDriverToClerk(
  driverId: number,
  phoneE164: string,
): Promise<string> {
  const normalizedPhone = phoneE164.startsWith("+") ? phoneE164 : `+${phoneE164}`;

  let clerkUserId: string;

  // Search for an existing user with this phone number.
  const searchResult = await clerkClient.users.getUserList({
    phoneNumber: [normalizedPhone],
    limit: 1,
  });

  const existingUser = searchResult.data?.[0];

  if (existingUser) {
    clerkUserId = existingUser.id;
    logger.info(
      { clerkUserId, driverId, phone: normalizedPhone },
      "clerkDriverSync: reusing existing Clerk user",
    );
    await clerkClient.users.updateUserMetadata(clerkUserId, {
      publicMetadata: { userType: "driver" },
      privateMetadata: { driverId },
    });
  } else {
    // Create a new Clerk user with phone number as the primary credential.
    const created = await clerkClient.users.createUser({
      phoneNumber: [normalizedPhone],
      publicMetadata: { userType: "driver" },
      privateMetadata: { driverId },
    });
    clerkUserId = created.id;
    logger.info(
      { clerkUserId, driverId, phone: normalizedPhone },
      "clerkDriverSync: created new Clerk user",
    );
  }

  return clerkUserId;
}
