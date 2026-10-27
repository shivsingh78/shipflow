import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, repoName, shortDigest, shortSha, timeAgo } from "./format";

describe("format", () => {
  it("formats durations", () => {
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(2 * 3600_000 + 3 * 60_000)).toBe("2h 03m");
    expect(formatDuration(null)).toBe("—");
  });

  it("shortens identifiers", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
    expect(shortSha(null)).toBe("—");
    expect(shortDigest(`sha256:${"a".repeat(64)}`)).toBe(`sha256:${"a".repeat(12)}…`);
  });

  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(98_000_000)).toBe("93 MB");
  });

  it("describes time relatively", () => {
    const now = Date.parse("2026-10-27T12:00:00Z");
    expect(timeAgo("2026-10-27T11:59:50Z", now)).toBe("just now");
    expect(timeAgo("2026-10-27T11:00:00Z", now)).toBe("1 hour ago");
    expect(timeAgo(null, now)).toBe("—");
  });

  it("extracts the repository name", () => {
    expect(repoName("https://github.com/acme/orders-api.git")).toBe("acme/orders-api");
  });
});
