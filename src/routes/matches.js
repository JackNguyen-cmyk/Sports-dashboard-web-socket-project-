import {Router} from 'express';
import { desc } from 'drizzle-orm';
import { createMatchSchema, listMatchesQuerySchema } from '../validation/matches.js';
import { db } from '../db/db.js';
import {matches} from '../db/schema.js';
import { getMatchStatus } from '../utils/match-status.js';
import { zodDetails } from '../validation/errors.js';

export const matchRouter = Router();

const MAX_LIMIT = 100;

matchRouter.get('/', async (req, res) => {
  const parsed = listMatchesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid query parameters", details: zodDetails(parsed.error) });
  }

  const limit = Math.min(parsed.data.limit ?? 50, MAX_LIMIT);
  
  try{
    const data = await db.select().from(matches).limit(limit).orderBy(desc(matches.createdAt));
    res.status(200).json({ matches: data });  
  }catch (error) {
    // Logged rather than returned: a Postgres error names the table, column and
    // constraint it failed on, which is internal detail a client has no use for
    // and an attacker does. Stringifying a string only adds quotes - it was
    // never redacting anything.
    console.error('failed to retrieve matches', error);
    return res.status(500).json({ error: "Failed to retrieve matches" });
  }
});

matchRouter.post('/', async (req, res) => {
  const parsed = createMatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid payload", details: zodDetails(parsed.error) });
  }
  // getMatchStatus returns null when it cannot interpret the dates, and
  // status is NOT NULL. Zod should already have rejected such input, but do
  // not depend on a guarantee made in another file - fail here with a clear
  // 400 rather than letting a null reach Postgres as an opaque 23502.
  const status = getMatchStatus(parsed.data.startTime, parsed.data.endTime);
  if (!status) {
    return res.status(400).json({
      error: "invalid payload",
      details: "startTime/endTime could not be interpreted",
    });
  }

  try {
    const [event] = await db.insert(matches).values({
      ...parsed.data,
      startTime: new Date(parsed.data.startTime),
      endTime: parsed.data.endTime ? new Date(parsed.data.endTime) : null,
      homeScore: parsed.data.homeScore ?? 0,
      awayScore: parsed.data.awayScore ?? 0,
      status
    }).returning();

    res.status(201).json({ message: "Match created successfully", match: event });

    // Broadcast after responding, and outside the insert's try/catch: the row
    // is already committed, so a notification failure must not turn a
    // successful create into a 500.
    try {
      res.app.locals.broadcastMatchCreated?.(event);
    } catch (broadcastError) {
      console.error('broadcastMatchCreated failed', broadcastError);
    }
  }
  catch (error) {
    // Same reasoning as the GET above: log the detail, return a generic message.
    console.error('failed to create match', error);
    return res.status(500).json({ error: "Failed to create match" });
  } 
  
});