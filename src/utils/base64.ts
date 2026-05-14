/**
 * Base64-encode a string for use in the HTTP `Authorization: Basic` header.
 *
 * Uses the global `btoa` (Node 18+ / Bun) so this works without pulling in
 * `Buffer` from `node:buffer`.
 */
export function base64BasicAuth(user: string, pass: string): string {
  return btoa(`${user}:${pass}`);
}
