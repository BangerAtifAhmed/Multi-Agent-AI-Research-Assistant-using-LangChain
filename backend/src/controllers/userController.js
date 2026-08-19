import userModel, { toPublicUser } from '../models/userModel.js';
import sessionModel from '../models/sessionModel.js';
import ApiError from '../utils/ApiError.js';

export async function profile(req, res) {
  const [user, usage] = await Promise.all([
    userModel.findById(req.user.id),
    userModel.getUsageStats(req.user.id),
  ]);
  if (!user) throw ApiError.unauthorized();
  res.json({ user: toPublicUser(user), usage });
}

export async function updateProfile(req, res) {
  const name = req.body?.name;
  if (name !== undefined) {
    const clean = String(name).trim();
    if (clean.length < 2 || clean.length > 80) {
      throw ApiError.badRequest('Name must be between 2 and 80 characters.', 'INVALID_NAME');
    }
  }

  const updated = await userModel.updateProfile(req.user.id, {
    name: name === undefined ? null : String(name).trim(),
  });
  if (!updated) throw ApiError.notFound('User not found');

  res.json({ user: toPublicUser(updated) });
}

/** Signs the user out of every device (also used after a password change). */
export async function logoutEverywhere(req, res) {
  const count = await sessionModel.destroyUserSessions(req.user.id);
  res.json({ success: true, sessionsRevoked: count });
}

export default { profile, updateProfile, logoutEverywhere };
