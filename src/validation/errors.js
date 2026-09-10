/**
 * Turning a Zod failure into something a client can act on.
 *
 * `JSON.stringify(parsed.error)` produces an escaped blob containing the whole
 * internal error shape - unreadable in a response body, and it leaks more of
 * the schema than a caller needs. This keeps the two things a caller can
 * actually fix: which field was wrong, and why.
 *
 * Shared by both routers rather than duplicated, so the two cannot drift into
 * reporting validation failures in different shapes.
 *
 * `z.flattenError(error).fieldErrors` is the built-in alternative; this form is
 * kept because it preserves nested paths (`metadata.xg` rather than `metadata`).
 */
export const zodDetails = (error) =>
  error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  }));
