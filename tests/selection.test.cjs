const { chooseFairProgram } = require("../electron/selection.cjs");

describe("fair programme selection", () => {
  const candidates = [
    { programId: 1, selectionCount: 10, lastSelectedAt: "2026-09-29T10:00:00Z" },
    { programId: 2, selectionCount: 0, lastSelectedAt: null },
    { programId: 3, selectionCount: 2, lastSelectedAt: "2026-09-20T10:00:00Z" }
  ];

  it("does not repeat the immediately previous programme when alternatives exist", () => {
    for (let index = 0; index < 20; index += 1) {
      expect(chooseFairProgram(candidates, { lastProgramId: 1, random: () => index / 20 }).programId).not.toBe(1);
    }
  });

  it("returns the only eligible programme", () => {
    expect(chooseFairProgram([candidates[0]], { lastProgramId: 1 })).toBe(candidates[0]);
  });

  it("returns null for an exhausted library", () => {
    expect(chooseFairProgram([])).toBeNull();
  });
});
