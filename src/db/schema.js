import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/**
 * Lifecycle of a match. Kept as a native PG enum so invalid states are
 * rejected by the database, not just the application layer.
 */
export const matchStatus = pgEnum('match_status', [
  'scheduled',
  'live',
  'finished',
]);

export const matches = pgTable(
  'matches',
  {
    id: serial('id').primaryKey(),
    sport: text('sport').notNull(),
    homeTeam: text('home_team').notNull(),
    awayTeam: text('away_team').notNull(),
    status: matchStatus('status').notNull().default('scheduled'),

    // timestamptz: fixtures span timezones, so store absolute instants.
    startTime: timestamp('start_time', { withTimezone: true }).notNull(),
    // Null until the match actually ends.
    endTime: timestamp('end_time', { withTimezone: true }),

    homeScore: integer('home_score').notNull().default(0),
    awayScore: integer('away_score').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Drives the "what's on now" and "today's fixtures" queries.
    index('matches_status_start_time_idx').on(table.status, table.startTime),
    index('matches_sport_start_time_idx').on(table.sport, table.startTime),
  ],
);

export const commentary = pgTable(
  'commentary',
  {
    id: serial('id').primaryKey(),

    matchId: integer('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),

    // Clock minute of the event (null for pre-match / administrative entries).
    minute: integer('minute'),
    // Monotonic per-match ordering key; the feed is ordered by this, not by id.
    sequence: integer('sequence').notNull(),
    // e.g. '1H', '2H', 'ET', 'PENS' - free-form to stay sport-agnostic.
    period: text('period'),

    eventType: text('event_type').notNull(),
    actor: text('actor'),
    team: text('team'),
    message: text('message').notNull(),

    // Sport-specific payload (xG, card colour, substitution pair, ...).
    metadata: jsonb('metadata'),
    tags: text('tags').array(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Guarantees no two events claim the same slot in a match's feed.
    uniqueIndex('commentary_match_id_sequence_idx').on(
      table.matchId,
      table.sequence,
    ),
    // Primary read path: newest events for one match.
    index('commentary_match_id_created_at_idx').on(
      table.matchId,
      table.createdAt,
    ),
  ],
);

export const matchesRelations = relations(matches, ({ many }) => ({
  commentary: many(commentary),
}));

export const commentaryRelations = relations(commentary, ({ one }) => ({
  match: one(matches, {
    fields: [commentary.matchId],
    references: [matches.id],
  }),
}));
