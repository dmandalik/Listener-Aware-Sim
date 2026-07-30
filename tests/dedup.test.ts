// Data-cleaning rules applied before analysis: drop test/dev runs, and keep only the
// FIRST chronological submission per person (matched by name or email).

import { describe, expect, it } from "vitest";
import { getDuplicatePids, getExcludedPids, isTestParticipant } from "@/lib/test-participant";

describe("isTestParticipant", () => {
  it("matches 'test' anywhere in either name, case-insensitively", () => {
    expect(isTestParticipant("Test", "User")).toBe(true);
    expect(isTestParticipant("TESTing", "Smith")).toBe(true);
    expect(isTestParticipant("Alice", "Testerson")).toBe(true);
    expect(isTestParticipant("Test User", "")).toBe(true);
  });
  it("still catches a bare 'User' last name and blank names", () => {
    expect(isTestParticipant("Dave", "User")).toBe(true);
    expect(isTestParticipant(null, null)).toBe(true);
    expect(isTestParticipant("", "")).toBe(true);
  });
  it("leaves real participants alone", () => {
    expect(isTestParticipant("Johnny", "Appleseed")).toBe(false);
  });
});

describe("getDuplicatePids / getExcludedPids", () => {
  const p = (pid: string, first: string, last: string, email: string, createdAt: string) => ({
    prolificPid: pid, firstName: first, lastName: last, email, createdAt,
  });

  it("keeps the first submission and flags later ones with the same name or email as duplicates", () => {
    const rows = [
      p("pid1", "Johnny", "Appleseed", "123@gmail.com", "2026-01-01T00:00:00Z"),
      p("pid2", "Johnny", "Appleseed", "345@gmail.com", "2026-01-02T00:00:00Z"), // dup by name
      p("pid3", "Someone", "Else", "123@gmail.com", "2026-01-03T00:00:00Z"), // dup by email
      p("pid4", "Fresh", "Person", "fresh@gmail.com", "2026-01-04T00:00:00Z"), // unique
    ];
    const dupes = getDuplicatePids(rows);
    expect(dupes.has("pid1")).toBe(false);
    expect(dupes.has("pid2")).toBe(true);
    expect(dupes.has("pid3")).toBe(true);
    expect(dupes.has("pid4")).toBe(false);
  });

  it("is order-independent — sorts by createdAt, not array position", () => {
    const rows = [
      p("later", "Johnny", "Appleseed", "b@gmail.com", "2026-01-02T00:00:00Z"),
      p("earlier", "Johnny", "Appleseed", "a@gmail.com", "2026-01-01T00:00:00Z"),
    ];
    const dupes = getDuplicatePids(rows);
    expect(dupes.has("earlier")).toBe(false);
    expect(dupes.has("later")).toBe(true);
  });

  it("never treats test/dev rows as duplicates of each other", () => {
    const rows = [
      p("t1", "Test", "User", "", "2026-01-01T00:00:00Z"),
      p("t2", "Test", "User", "", "2026-01-02T00:00:00Z"),
    ];
    expect(getDuplicatePids(rows).size).toBe(0);
  });

  it("getExcludedPids unions test/dev pids with duplicate pids", () => {
    const rows = [
      p("real1", "Johnny", "Appleseed", "123@gmail.com", "2026-01-01T00:00:00Z"),
      p("real2", "Johnny", "Appleseed", "345@gmail.com", "2026-01-02T00:00:00Z"), // dup
      p("dev1", "Test", "User", "", "2026-01-03T00:00:00Z"), // test
    ];
    const excluded = getExcludedPids(rows);
    expect(excluded.has("real1")).toBe(false);
    expect(excluded.has("real2")).toBe(true);
    expect(excluded.has("dev1")).toBe(true);
  });
});
