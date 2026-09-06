import {Router} from 'express';

export const matchRouter = Router();

matchRouter.get('/', (req, res) => {
  res.status(200).json({ message: 'Hello from the match router!' });
});
