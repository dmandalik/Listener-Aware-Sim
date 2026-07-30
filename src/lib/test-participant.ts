// A "test" participant is an admin/dev run, not a real subject: named Test / User
// (any capitalization), either name containing "test" anywhere, or left blank. These
// must never count toward recruitment or enter the analysis exports — admins
// routinely play through under these names.

export function isTestParticipant(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): boolean {
  const f = (firstName ?? "").trim().toLowerCase();
  const l = (lastName ?? "").trim().toLowerCase();
  if (!f && !l) return true; // blank name
  if (f.includes("test") || l.includes("test")) return true;
  if (l === "user") return true;
  return false;
}

interface DedupCandidate {
  prolificPid: string;
  firstName: string | null | undefined;
  lastName: string | null | undefined;
  email: string | null | undefined;
  createdAt: string | Date;
}

/** Prolific pids of SECONDARY submissions from the same person: same (first, last)
 *  name combo, or same email, as an earlier (by `createdAt`) submission. Keeps only
 *  the first chronological submission per identity; every later one is "duplicate".
 *  Test/dev participants (see `isTestParticipant`) are ignored entirely — they never
 *  seed or count as a match. */
export function getDuplicatePids<T extends DedupCandidate>(participants: T[]): Set<string> {
  const real = participants
    .filter((p) => !isTestParticipant(p.firstName, p.lastName))
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const seenNames = new Set<string>();
  const seenEmails = new Set<string>();
  const duplicates = new Set<string>();

  for (const p of real) {
    const nameKey = `${(p.firstName ?? "").trim().toLowerCase()}|${(p.lastName ?? "").trim().toLowerCase()}`;
    const emailKey = (p.email ?? "").trim().toLowerCase();
    const hasName = nameKey !== "|";
    const isDup = (hasName && seenNames.has(nameKey)) || (!!emailKey && seenEmails.has(emailKey));
    if (isDup) {
      duplicates.add(p.prolificPid);
    } else {
      if (hasName) seenNames.add(nameKey);
      if (emailKey) seenEmails.add(emailKey);
    }
  }
  return duplicates;
}

/** Union of test/dev pids and secondary-submission pids — the full "never enter
 *  analysis" exclusion set for a given participant snapshot. */
export function getExcludedPids<T extends DedupCandidate>(participants: T[]): Set<string> {
  const excluded = new Set<string>(
    participants.filter((p) => isTestParticipant(p.firstName, p.lastName)).map((p) => p.prolificPid),
  );
  for (const pid of getDuplicatePids(participants)) excluded.add(pid);
  return excluded;
}
