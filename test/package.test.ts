import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { satisfies } from "semver"

test("published tui entrypoint shares host runtime instances via peerDependencies", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  const runtimeImports = ["@opentui/solid", "solid-js"]

  for (const dependency of runtimeImports) {
    // The TUI host provides its own OpenTUI/solid instances; shipping a
    // second copy in dependencies would break rendering across them.
    expect(packageJson.peerDependencies?.[dependency]).toBeString()
    expect(packageJson.dependencies?.[dependency]).toBeUndefined()
    // Local development keeps its own copies for typecheck and tests.
    expect(packageJson.devDependencies?.[dependency]).toBeString()
  }
})

test("engines.opencode covers the V2 beta line and stable 2.x while excluding the V1 line", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    engines?: Record<string, string>
  }
  const range = packageJson.engines?.opencode
  expect(range).toBeString()
  if (typeof range !== "string") throw new Error("expected engines.opencode to be a string range")

  // The range must cover the 0.0.0-beta-* V2 line and stable 2.x releases
  // while excluding the entire V1 (1.x) line and older stable releases.
  for (const version of ["0.0.0-beta-0", "0.0.0-beta-19425", "2.0.0", "2.0.16"]) {
    expect(satisfies(version, range)).toBe(true)
  }
  for (const version of ["0.0.0", "0.0.1", "0.5.0", "1.0.0", "1.17.0", "1.17.1", "1.17.2", "1.18.0"]) {
    expect(satisfies(version, range)).toBe(false)
  }
})
