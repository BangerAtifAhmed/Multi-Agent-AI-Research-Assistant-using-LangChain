import { Router } from 'express';

import conversationController from '../controllers/conversationController.js';
import asyncHandler from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = Router();

router.use(requireAuth);

router.post('/', asyncHandler(conversationController.create));
router.get('/', asyncHandler(conversationController.list));

// Declared before '/:id' so "search" is not captured as a conversation id.
router.get('/search', asyncHandler(conversationController.search));

router.get('/:id', asyncHandler(conversationController.getOne));
router.get('/:id/messages', asyncHandler(conversationController.messages));
router.patch('/:id', asyncHandler(conversationController.update));
router.patch('/:id/pin', asyncHandler(conversationController.pin));
router.delete('/:id', asyncHandler(conversationController.remove));
router.delete('/:id/messages', asyncHandler(conversationController.clear));

export default router;
