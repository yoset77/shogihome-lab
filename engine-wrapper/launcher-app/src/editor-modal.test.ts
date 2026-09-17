import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// window.prompt() has no text-input panel on macOS/Wry (it resolves to null),
// and the dialog plugin offers no prompt replacement. The editor must keep
// group create/rename inside an in-app modal. State unit tests cannot prove
// the input UI exists, so this file guards the wiring at the source level.
const editorSrc = readFileSync(fileURLToPath(new URL("./editor.ts", import.meta.url)), "utf-8");
const editorHtml = readFileSync(fileURLToPath(new URL("../editor.html", import.meta.url)), "utf-8");

// Strip comments: the rationale comments legitimately mention the native API.
const code = editorSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("group name input (macOS prompt regression)", () => {
  it("never calls window.prompt", () => {
    expect(code).not.toMatch(/window\s*\.\s*prompt\s*\(/);
  });

  it("drives create/rename through the in-app modal", () => {
    for (const id of ["groupNameModal", "groupNameInput", "groupNameSaveBtn", "groupNameCancelBtn"]) {
      expect(editorSrc, id).toContain(id);
      expect(editorHtml, id).toContain(id);
    }
  });

  it("guards the modal keydown handler against IME composition", () => {
    // Confirming/cancelling a conversion fires keydown Enter/Escape; without
    // the guard it would submit or close the modal mid-composition.
    expect(code).toContain("isImeComposingKey");
  });
});
