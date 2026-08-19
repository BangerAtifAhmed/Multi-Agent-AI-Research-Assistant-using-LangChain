const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (date) => {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

/** "Today" / "Yesterday" / "Previous 7 days" / "Older" */
export function relativeDayGroup(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return 'Older';

  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / DAY_MS);

  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days <= 7) return 'Previous 7 days';
  if (days <= 30) return 'Previous 30 days';
  return 'Older';
}

export function formatTime(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default { relativeDayGroup, formatTime, formatDateTime };
