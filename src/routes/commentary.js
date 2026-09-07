import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';

import { db } from '../db/db.js';
import { commentary } from '../db/schema.js';
import { createCommentarySchema, listCommentaryQuerySchema } from '../validation/commentary.js';
import { matchIdParamSchema } from '../validation/matches.js';

// mergeParams lets this router see :id from the path it is mounted under
// (/matches/:id/commentary). Without it req.params is empty here, because a
// child router only sees the segment it was mounted with.
export const commentaryRouter = Router({ mergeParams: true });

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

// Shared by both handlers: the path segment is the only source of the match id.
const parseMatchId = (req) => matchIdParamSchema.safeParse(req.params);

const zodDetails = (error) =>
  error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));

commentaryRouter.get('/', async (req, res) => {
  const parsedParams = parseMatchId(req);
  if (!parsedParams.success) {
    return res.status(400).json({ error: 'invalid match id', details: zodDetails(parsedParams.error) });
  }

  const parsedQuery = listCommentaryQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json({ error: 'invalid query parameters', details: zodDetails(parsedQuery.error) });
  }

  const limit = Math.min(parsedQuery.data.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  try {
    const entries = await db
      .select()
      .from(commentary)
      .where(eq(commentary.matchId, parsedParams.data.id))
      // createdAt alone is not a total order - two events inserted in the same
      // millisecond would come back in whatever order the planner chose, and
      // the page could differ between identical requests. sequence is unique
      // per match, so it breaks every tie deterministically.
      .orderBy(desc(commentary.createdAt), desc(commentary.sequence))
      .limit(limit);

    return res.status(200).json({ commentary: entries });
  } catch (error) {
    // Logged rather than returned: a Postgres error exposes table, column and
    // constraint names.
    console.error('failed to fetch commentary', error);
    return res.status(500).json({ error: 'Failed to retrieve commentary' });
  }
});

commentaryRouter.post('/', async (req, res) => {
  const parsedParams = parseMatchId(req);
  if (!parsedParams.success) {
    return res.status(400).json({ error: 'invalid match id', details: zodDetails(parsedParams.error) });
  }

  const parsedBody = createCommentarySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: 'invalid payload', details: zodDetails(parsedBody.error) });
  }

  try {
    // matchId comes from the path, never the body, so the two cannot disagree.
    const [entry] = await db
      .insert(commentary)
      .values({ ...parsedBody.data, matchId: parsedParams.data.id })
      .returning();

    return res.status(201).json({ message: 'Commentary created successfully', commentary: entry });
  } catch (error) {
    // Drizzle wraps driver errors in a DrizzleQueryError, so the Postgres
    // SQLSTATE lives on `cause`, not on the error itself. Falling back to
    // error.code keeps this working if an unwrapped error ever reaches here.
    const code = error?.cause?.code ?? error?.code;

    // The database enforces two invariants this route can violate, and each
    // deserves its own status rather than a blanket 500.
    if (code === '23503') {
      // foreign_key_violation: no match with that id.
      return res.status(404).json({ error: 'Match not found' });
    }
    if (code === '23505') {
      // unique_violation on (match_id, sequence): that slot in this match's
      // feed is already taken, which is a conflict, not a server fault.
      return res.status(409).json({ error: 'Commentary with that sequence already exists for this match' });
    }

    // Logged server-side rather than returned: a Postgres error exposes table,
    // column and constraint names.
    console.error('failed to create commentary', error);
    return res.status(500).json({ error: 'Failed to create commentary' });
  }
});
