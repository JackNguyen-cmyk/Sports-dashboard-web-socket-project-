import { z } from 'zod';

// Postgres `integer` is 4 bytes. Zod happily accepts anything larger, and the
// insert then fails with 22003 numeric_value_out_of_range - which surfaces as
// a 500 for what is really a bad request.
const PG_INT4_MAX = 2_147_483_647;

const boundedString = (label, max) =>
  z
    .string({ message: `${label} is required` })
    .trim()
    .min(1, { message: `${label} must not be empty` })
    .max(max, { message: `${label} must be at most ${max} characters` });

// Deliberately NOT z.coerce here. Coercion is Number() underneath, so
// z.coerce.number() turns null into 0, true into 1 and [] into 0 - meaning a
// client sending "minute": null would silently store minute 0, which reads as
// an event at kickoff rather than an unknown minute. A JSON body already
// carries real numbers, so coercion buys nothing and loses that distinction.
// Query and path params still coerce, because there everything is a string.
const boundedInt = (label) =>
  z
    .number({ message: `${label} must be a number` })
    .int({ message: `${label} must be an integer` })
    .nonnegative({ message: `${label} must not be negative` })
    .max(PG_INT4_MAX, { message: `${label} is too large` });

// Query params arrive as strings, hence the coercion.
export const listCommentaryQuerySchema = z.object({
  limit: z.coerce
    .number({ message: 'limit must be a number' })
    .int({ message: 'limit must be an integer' })
    .positive({ message: 'limit must be greater than 0' })
    .max(100, { message: 'limit must not exceed 100' })
    .optional(),
});

/**
 * matchId is deliberately absent: commentary is created under a match
 * (POST /matches/:id/commentary), so the id comes from the path via
 * matchIdParamSchema. Taking it from the body too would allow the two to
 * disagree.
 *
 * Required vs optional mirrors the NOT NULL columns in ../db/schema.js. An
 * optional field here that the database requires would surface as an opaque
 * 23502 constraint error naming a column the client never sent.
 */
export const createCommentarySchema = z.object({
  // Null in the database for pre-match and administrative entries.
  minute: boundedInt('minute').optional(),

  // NOT NULL, and unique per match: the feed is ordered by this, not by id.
  sequence: boundedInt('sequence'),

  // Free-form to stay sport-agnostic - '1H', '2H', 'ET', 'PENS'.
  period: boundedString('period', 20).optional(),

  eventType: boundedString('eventType', 50),
  actor: boundedString('actor', 100).optional(),
  team: boundedString('team', 100).optional(),
  message: boundedString('message', 2000),

  // Sport-specific payload for the jsonb column. z.record(key, value) means
  // "an object with arbitrary keys of this value type" - it accepts any shape
  // of object while still rejecting arrays and null, which raw jsonb would
  // happily store.
  metadata: z.record(z.string(), z.unknown()).optional(),

  tags: z.array(boundedString('tag', 50)).max(20, { message: 'at most 20 tags' }).optional(),
});
