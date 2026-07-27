import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"

const root = path.resolve(import.meta.dir, "..")

function files(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((name) => {
      const target = path.join(directory, name)
      return statSync(target).isDirectory() ? files(target) : [target]
    })
    .filter(
      (target) =>
        path.basename(target) !== ".cat-source.json" &&
        path.relative(root, target).split(path.sep).join("/") !== "tests/source-manifest.test.ts",
    )
    .sort()
}

function sourceHash(): string {
  const hash = createHash("sha256")
  for (const file of files(root)) {
    hash.update(path.relative(root, file).split(path.sep).join("/"))
    hash.update("\0")
    hash.update(readFileSync(file))
    hash.update("\0")
  }
  return hash.digest("hex")
}

describe("CAT source manifest", () => {
  test("matches the build-integrated mirror", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, ".cat-source.json"), "utf8"))
    expect(manifest.schema_version).toBe(1)
    expect(manifest.source_tree_sha256).toBe(sourceHash())
  })
})
