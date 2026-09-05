import { Router } from 'express';

import chatController from '../controllers/chatController.js';
import asyncHandler from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { dailyChatLimit } from '../middleware/chatDailyLimit.js';
import rateLimit from '../middleware/rateLimit.js';

const router = Router();

// Order matters: the per-minute burst limiter runs first, so a request it
// rejects never spends one of the day's ten chats.
router.post(
  '/',
  requireAuth,
  rateLimit({ name: 'chat', by: 'user' }),
  dailyChatLimit(),
  asyncHandler(chatController.chat),
);

// Deliberately not behind dailyChatLimit(): reading how many chats are left
// must not spend one.
router.get('/limit', requireAuth, asyncHandler(chatController.chatLimit));

export default router;
