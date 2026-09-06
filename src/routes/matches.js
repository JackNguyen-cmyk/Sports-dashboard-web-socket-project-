import {Router} from 'express';
import { createMatchSchema } from '../validation/matches.js';
import { db } from '../db/db.js';
import {matches} from '../db/schema.js';
import { getMatchStatus } from '../utils/match-status.js';

export const matchRouter = Router();

matchRouter.get('/', (req, res) => {
  res.status(200).json({ message: 'Hello from the match router!' });
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