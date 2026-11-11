import { describe, expect, it } from "vitest";
import { canAct, canView, type Identity } from "../../src/core/contracts";

const id = (personas: Identity["personas"], active: Identity["active"]): Identity =>
  ({ login: "u", personas, active, isAdmin: false, owner: "o", repo: "r", orgOwned: true });

describe("persona visibility", () => {
  it("architect sees all three views but acts only as architect", () => {
    const a = id(["architect"], "architect");
    expect(["architect", "developer", "tester"].every((v) => canView(a, v as any))).toBe(true);
    expect(canAct(a, "architect")).toBe(true);
    expect(canAct(a, "developer")).toBe(false);
    expect(canAct(a, "tester")).toBe(false);
  });
  it("developer and tester see only their own view", () => {
    expect(canView(id(["developer"], "developer"), "tester")).toBe(false);
    expect(canView(id(["tester"], "tester"), "developer")).toBe(false);
    expect(canView(id(["tester"], "tester"), "architect")).toBe(false);
    expect(canAct(id(["tester"], "tester"), "tester")).toBe(true);
  });
});
