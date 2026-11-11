import { createHash } from "crypto";
import type { TestCase } from "./types";

/** Fingerprint of what a case tests: a stored spec or recording is only replayed while this is unchanged. */
export function caseHash(tc: TestCase): string {
  const body = JSON.stringify([tc.title, tc.preconditions ?? [], tc.steps, tc.expected, tc.data ?? null]);
  return createHash("sha1").update(body).digest("hex").slice(0, 16);
}

/** Text of a case used to spot which org objects it talks about. */
export function caseText(c: TestCase): string {
  return [c.title, c.description, ...(c.preconditions ?? []), ...c.steps, ...c.expected].filter(Boolean).join("\n");
}
