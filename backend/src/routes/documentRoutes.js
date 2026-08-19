import { Router } from 'express';

import documentController from '../controllers/documentController.js';
import asyncHandler from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import rateLimit from '../middleware/rateLimit.js';
import uploadDocument from '../middleware/upload.js';

const router = Router();

// Every document route requires a session; ownership is enforced in SQL.
router.use(requireAuth);

router.get('/', asyncHandler(documentController.list));
router.get('/formats', asyncHandler(documentController.formats));
router.post(
  '/',
  rateLimit({ name: 'upload', by: 'user' }),
  uploadDocument,
  asyncHandler(documentController.upload),
);
router.get('/:id', asyncHandler(documentController.get));
router.delete('/:id', asyncHandler(documentController.remove));

export default router;
