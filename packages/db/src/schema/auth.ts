import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { studios, users } from './base';

/**
 * One opaque bearer token. Shape from `NativeAccessToken` in the contract:
 * opaque, `naa_` prefix, short-lived. The server verifies the token, resolves
 * the studio and the user, and projects capabilities from the user's role.
 *
 * SOL-28 ships token verification only. The PKCE issue flow (`/auth/token`)
 * and revocation belong to the authentication issue on the roadmap.
 */
export const accessTokens = pgTable(
  'access_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    studioId: uuid('studio_id')
      .notNull()
      .references(() => studios.id),
    /** The `users.id` this token acts as. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [uniqueIndex('access_tokens_token_idx').on(table.token)],
);
