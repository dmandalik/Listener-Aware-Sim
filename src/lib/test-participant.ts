// A "test" participant is an admin/dev run, not a real subject: named Test / User
// (any capitalization) or left blank. These must never count toward recruitment or
// enter the analysis exports — admins routinely play through under these names.

export function isTestParticipant(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): boolean {
  const f = (firstName ?? "").trim().toLowerCase();
  const l = (lastName ?? "").trim().toLowerCase();
  if (!f && !l) return true; // blank name
  if (f === "test") return true;
  if (l === "user") return true;
  return false;
}
