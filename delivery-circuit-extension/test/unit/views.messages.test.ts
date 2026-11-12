import { describe, expect, it } from "vitest";
import { safeRelativePath, sanitizeAction, sanitizeFeatureId, sanitizeLink, sanitizePersona, sanitizeSourceId } from "../../src/views/messages";

describe("webview message validation", () => {
  it("accepts https and workspace-relative links only", () => {
    expect(sanitizeLink({ kind: "github", label: "PR", target: "https://github.com/o/r/pull/1" })).toBeTruthy();
    expect(sanitizeLink({ kind: "github", label: "x", target: "http://github.com" })).toBeUndefined();
    expect(sanitizeLink({ kind: "url", label: "x", target: "javascript:alert(1)" })).toBeUndefined();
    expect(sanitizeLink({ kind: "file", label: "spec", target: ".specify/specs/001-x/spec.md" })).toBeTruthy();
    expect(sanitizeLink({ kind: "file", label: "x", target: "../secrets.txt" })).toBeUndefined();
    expect(sanitizeLink({ kind: "file", label: "x", target: "C:\\Windows\\win.ini" })).toBeUndefined();
    expect(sanitizeLink({ kind: "report", label: "x", target: "/etc/passwd" })).toBeUndefined();
    expect(sanitizeLink({ kind: "evil", label: "x", target: "https://x" })).toBeUndefined();
    expect(sanitizeLink("https://x")).toBeUndefined();
  });
  it("path checks", () => {
    expect(safeRelativePath("a/b/c.md")).toBe(true);
    expect(safeRelativePath("a/../../b")).toBe(false);
    expect(safeRelativePath("")).toBe(false);
  });
  it("accepts well-formed actions and strips extra fields", () => {
    const a = sanitizeAction({ id: "ai:/dev-review-pr", label: "Review PR", persona: "developer", kind: "ai", args: { command: "/dev-review-pr", arg: 42 }, allowed: true, reason: "x" });
    expect(a).toEqual({ id: "ai:/dev-review-pr", label: "Review PR", persona: "developer", kind: "ai", args: { command: "/dev-review-pr", arg: 42 } });
  });
  it("rejects malformed actions", () => {
    expect(sanitizeAction({ id: "x", persona: "admin", kind: "ai" })).toBeUndefined();
    expect(sanitizeAction({ id: "x", persona: "developer", kind: "shell" })).toBeUndefined();
    expect(sanitizeAction({ id: "x", persona: "developer", kind: "ai", args: { arg: { nested: 1 } } })).toBeUndefined();
    expect(sanitizeAction({ id: "x", persona: "developer", kind: "ai", args: { "bad key": 1 } })).toBeUndefined();
    expect(sanitizeAction(null)).toBeUndefined();
  });
  it("ids", () => {
    expect(sanitizePersona("tester")).toBe("tester");
    expect(sanitizePersona("root")).toBeUndefined();
    expect(sanitizeFeatureId("001")).toBe("001");
    expect(sanitizeFeatureId("001-case-escalation")).toBe("001-case-escalation");
    expect(sanitizeFeatureId("../001")).toBeUndefined();
    expect(sanitizeFeatureId("ACME-12")).toBe("ACME-12");
    expect(sanitizeFeatureId("ACME-12-case-escalation")).toBe("ACME-12-case-escalation");
    expect(sanitizeFeatureId("page-2240011")).toBe("page-2240011");
    expect(sanitizeFeatureId("acme-12; rm")).toBeUndefined();
    expect(sanitizeSourceId("fireflies:01JD8Q2KX7")).toBe("fireflies:01JD8Q2KX7");
    expect(sanitizeSourceId("upload:../../x")).toBeUndefined();
  });
});
