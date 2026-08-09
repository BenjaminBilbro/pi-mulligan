import { describe, it } from "vitest";

describe("extension load smoke", () => {
  it("should load the extension without error", () => {
    // Gate: `pi -e ./src/index.ts -p hi` exits 0
    // This test is a placeholder; the real validation is the smoke script.
    // The smoke script in package.json ("smoke") runs:
    //   pi -e ./src/index.ts -p "hi"
    // and must exit 0.
    expect(true).toBe(true);
  });
});
