import { z } from 'zod';

/**
 * Canonical match lifecycle values. Mirrors the `match_status` PG enum
 * declared in ../db/schema.js - keep the two in sync.
 */
export const MATCH_STATUS = {
  SCHEDULED: 'scheduled',
  LIVE: 'live',
  FINISHED: 'finished',
};

/**
 * ISO 8601 date or date-time. `Date.parse` alone is too permissive
 * (it happily accepts "March 5 2026"), so shape is checked first.
 */
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const isIsoDateString = (value) =>
  ISO_DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(value));

const isoDateString = (label) =>
  z
    .string()
    .refine(isIsoDateString, { message: `${label} must be a valid ISO date string` });

// Query params arrive as strings, hence the coercion.
export const listMatchesQuerySchema = z.object({
  limit: z.coerce
    .number({ message: 'limit must be a number' })
    .int({ message: 'limit must be an integer' })
    .positive({ message: 'limit must be greater than 0' })
    .max(100, { message: 'limit must not exceed 100' })
    .optional(),
});

export const matchIdParamSchema = z.object({
  id: z.coerce
    .number({ message: 'id must be a number' })
    .int({ message: 'id must be an integer' })
    .positive({ message: 'id must be greater than 0' }),
});

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

export const createMatchSchema = z
  .object({
    sport: nonEmptyString('sport'),
    homeTeam: nonEmptyString('homeTeam'),
    awayTeam: nonEmptyString('awayTeam'),
    startTime: isoDateString('startTime'),
    endTime: isoDateString('endTime').optional(),
    homeScore: nonNegativeInt('homeScore').optional(),
    awayScore: nonNegativeInt('awayScore').optional(),
  })
  .superRefine((data, ctx) => {
    // Nothing to compare against until an end time is supplied.
    if (data.endTime === undefined) {
      return;
    }

    // Only meaningful once both fields individually parsed as ISO dates.
    if (!isIsoDateString(data.startTime) || !isIsoDateString(data.endTime)) {
      return;
    }

    if (Date.parse(data.endTime) <= Date.parse(data.startTime)) {
      ctx.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: 'endTime must be after startTime',
      });
    }
  });

export const updateScoreSchema = z.object({
  homeScore: nonNegativeInt('homeScore'),
  awayScore: nonNegativeInt('awayScore'),
});
