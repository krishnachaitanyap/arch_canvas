/** File-name-safe version of a diagram title. */
export const slug = (s: string) => s.trim().replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "diagram";

/** "just now", "5 min ago", "3 h ago", "2 d ago", or a date. */
export function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
