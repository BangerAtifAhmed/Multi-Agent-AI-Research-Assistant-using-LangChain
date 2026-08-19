import { request, API_BASE_URL } from './apiClient.js';

export const signup = (payload) =>
  request('/auth/signup', { method: 'POST', body: payload }).then((data) => data.user);

export const login = (payload) =>
  request('/auth/login', { method: 'POST', body: payload }).then((data) => data.user);

export const logout = () => request('/auth/logout', { method: 'POST' });

export const me = () => request('/auth/me').then((data) => data.user);

export const authConfig = () => request('/auth/config');

export const getProfile = () => request('/user');

export const updateProfile = (payload) =>
  request('/user', { method: 'PATCH', body: payload }).then((data) => data.user);

export const logoutEverywhere = () => request('/user/logout-all', { method: 'POST' });

/**
 * Google sign-in is a full-page redirect, not a fetch: the backend owns the
 * whole OAuth exchange and the browser never sees the client secret.
 *
 * Built from API_BASE_URL, which is normalised to include the server's `/api`
 * mount point, so this resolves to <api-origin>/api/auth/google in every
 * environment. Nothing here is hard-coded.
 */
export const googleLoginUrl = (redirectTo = '/') =>
  `${API_BASE_URL}/auth/google?redirectTo=${encodeURIComponent(redirectTo)}`;

export default {
  signup,
  login,
  logout,
  me,
  authConfig,
  getProfile,
  updateProfile,
  logoutEverywhere,
  googleLoginUrl,
};
