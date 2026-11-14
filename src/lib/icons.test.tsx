// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "../ds";
import { registerIcons } from "./icons";

const kebab = (pascal: string) => pascal.replace(/(?<=[a-z0-9])(?=[A-Z])|(?<=[a-zA-Z])(?=\d)/g, "-").toLowerCase();

/** The names a screen may pass to `<Icon name>`, kebab case ("triangle-alert"): what `registerIcons` hands the design system. */
registerIcons();
const REGISTERED_ICONS = Object.keys(window.lucide!.icons).map(kebab);

/** Every icon name written as a literal in the UI: `<Icon name="x">` and `icon="x"` props. */
function iconNamesUsedIn(dir: string): Set<string> {
  const names = new Set<string>();
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      for (const name of iconNamesUsedIn(path)) names.add(name);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/<Icon\s+name="([a-z0-9-]+)"/g)) names.add(match[1]!);
      for (const match of source.matchAll(/\bicon(?:Name)?[=:]\s*"([a-z0-9-]+)"/g)) names.add(match[1]!);
    }
  }
  return names;
}

describe("icon registry", () => {
  it("draws a registered icon as an svg through the design system's Icon", async () => {
    registerIcons();
    const { container } = render(<Icon name="menu" />);
    await expect.poll(() => container.querySelector("svg")).not.toBeNull();
  });

  it("registers every icon the desk's screens name", () => {
    const used = iconNamesUsedIn(join(__dirname, "../ui"));
    const missing = [...used].filter((name) => !REGISTERED_ICONS.includes(name));
    expect(missing).toEqual([]);
  });

  it("registers the icons the screens in docs/design.md will need", () => {
    for (const name of ["menu", "x", "eye", "eye-off", "upload", "send", "copy", "triangle-alert", "sparkles", "flask-conical"]) {
      expect(REGISTERED_ICONS).toContain(name);
    }
  });
});
