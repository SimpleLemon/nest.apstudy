// Atlas meeting tokens represent minutes since the start of the meeting day.
// 2400 is the exclusive end of that day; later minutes in hour 24 are invalid.
export function parseAtlasTimeToken(token) {
  const numeric = String(token ?? "").replace(/\D/g, "");
  if (!numeric) return null;
  const padded = numeric.length >= 4 ? numeric.slice(-4) : numeric.padStart(4, "0");
  const hour = Number.parseInt(padded.slice(0, 2), 10);
  const minute = Number.parseInt(padded.slice(2, 4), 10);
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) return null;
  return hour * 60 + minute;
}
