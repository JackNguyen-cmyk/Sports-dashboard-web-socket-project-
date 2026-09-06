import {Router} from 'express';
import { desc } from 'drizzle-orm';
import { createMatchSchema, listMatchesQuerySchema } from '../validation/matches.js';
import { db } from '../db/db.js';
import {matches} from '../db/schema.js';
import { getMatchStatus } from '../utils/match-status.js';

export const matchRouter = Router();

const MAX_LIMIT = 100;

matchRouter.get('/', async (req, res) => {
  const parsed = listMatchesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid query parameters", details: JSON.stringify(parsed.error) });
  }

  const limit = Math.min(parsed.data.limit ?? 50, MAX_LIMIT);
  
  try{
    const data = await db.select().from(matches).limit(limit).orderBy(desc(matches.createdAt));
    res.status(200).json({ matches: data });  
  }catch (error) {
    return res.status(500).json({ error: "Failed to retrieve matches", details: JSON.stringify(error.message) });
  }
});

matchRouter.post('/', async (req, res) => {
  const parsed = createMatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid payload", details: JSON.stringify(parsed.error) });
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
  }
  catch (error) {
    return res.status(500).json({ error: "Failed to create match", details: JSON.stringify(error.message) });
  } 
  
});