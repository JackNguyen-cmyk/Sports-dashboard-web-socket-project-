import { Router } from 'express';

import { db } from '../db/db.js';
import { commentary } from '../db/schema.js';
import { createCommentarySchema } from '../validation/commentary.js';
import { matchIdParamSchema } from '../validation/matches.js';

// mergeParams lets this router see :id from the path it is mounted under
// (/matches/:id/commentary). Without it req.params is empty here, because a
// child router only sees the segment it was mounted with.
export const commentaryRouter = Router({ mergeParams: true });

commentaryRouter.post('/', async (req, res) => {
  const parsedParams = matchIdParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({
      error: 'invalid match id',
      details: parsedParams.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    });
  }

  const parsedBody = createCommentarySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: 'invalid payload',
      details: parsedBody.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    });
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
