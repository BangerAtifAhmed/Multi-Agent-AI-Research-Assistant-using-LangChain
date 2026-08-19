import { Router } from 'express';

import chatController from '../controllers/chatController.js';
import asyncHandler from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import rateLimit from '../middleware/rateLimit.js';

const router = Router();

router.post(
  '/',
  requireAuth,
  rateLimit({ name: 'chat', by: 'user' }),
  asyncHandler(chatController.chat),
);

export default router;
