// src/utils.js — shared helper functions

// Convert seconds → human readable duration
function formatDuration(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (seconds < 86400) return `${h}h ${m}m ${s}s`;
  const d = Math.floor(seconds / 86400);
  const remH = Math.floor((seconds % 86400) / 3600);
  return `${d}d ${remH}h ${m}m`;
}

module.exports = { formatDuration };