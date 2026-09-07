import { z } from 'zod';

const nonEmptyString = (label) =>
  z
    .string({ message: `${label} is required` })
    .trim()
    .min(1, { message: `${label} must not be empty` });

const nonNegativeInt = (label) =>
  z.coerce
    .number({ message: `${label} must be a number` })
    .int({ message: `${label} must be an integer` })
    .nonnegative({ message: `${label} must not be negative` });

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
  minute: nonNegativeInt('minute').optional(),

  // NOT NULL, and unique per match: the feed is ordered by this, not by id.
  sequence: nonNegativeInt('sequence'),

  // Free-form to stay sport-agnostic - '1H', '2H', 'ET', 'PENS'.
  period: nonEmptyString('period').optional(),

  eventType: nonEmptyString('eventType'),
  actor: nonEmptyString('actor').optional(),
  team: nonEmptyString('team').optional(),
  message: nonEmptyString('message'),

  // Sport-specific payload for the jsonb column. z.record(key, value) means
  // "an object with arbitrary keys of this value type" - it accepts any shape
  // of object while still rejecting arrays and null, which raw jsonb would
  // happily store.
  metadata: z.record(z.string(), z.unknown()).optional(),

  tags: z.array(nonEmptyString('tag')).optional(),
});
