/** File-name-safe version of a diagram title. */
export const slug = (s: string) => s.trim().replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "diagram";
