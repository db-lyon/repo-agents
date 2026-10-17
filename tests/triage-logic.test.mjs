import { describe, it, expect } from "vitest";
import { candidateTable, duplicateQueries } from "../stages/triage/logic.mjs";

describe("triage candidates", () => {
  it("offers only older issues, newest first", () => {
    const t = candidateTable([{ number: 2, state: "OPEN", title: "a" }, { number: 5, state: "OPEN", title: "b" }, { number: 1, state: "CLOSED", title: "c" }], 3);
    expect(t).toContain("#2");
    expect(t).toContain("#1");
    expect(t).not.toContain("#5");
    expect(t.indexOf("#2")).toBeLessThan(t.indexOf("#1"));
  });

  it("says so when nothing older came back", () => {
    expect(candidateTable([{ number: 9, state: "OPEN", title: "x" }], 3)).toMatch(/No candidates/);
  });

  it("builds queries from identifiers and title words", () => {
    const q = duplicateQueries("wordCount is wrong with double spaces", "call wordCount(\"a  b\")");
    expect(q[0]).toContain("wordcount");
    expect(q).toContain("wordCount");
  });
});
