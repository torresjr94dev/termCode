import { describe, expect, it } from "vitest";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import { languageFor, toLines } from "./highlight";

hljs.registerLanguage("typescript", typescript);

describe("resaltado", () => {
  it("elige el lenguaje por extensión o nombre", () => {
    expect(languageFor("src/App.tsx")).toBe("typescript");
    expect(languageFor("src-tauri/src/lib.rs")).toBe("rust");
    expect(languageFor("Dockerfile.dev")).toBe("dockerfile");
    expect(languageFor(".env.local")).toBe("ini");
    expect(languageFor("LICENSE")).toBeNull();
  });

  it("convierte la salida en segmentos por línea, incluidos comentarios de varias líneas", () => {
    const code = "/* uno\n   dos */\nconst a = '<b>&';";
    const lines = toLines(hljs.highlight(code, { language: "typescript" }).value);
    expect(lines).not.toBeNull();
    expect(lines).toHaveLength(3);
    expect(lines![1]).toEqual([{ text: "   dos */", cls: "tok-comment" }]);
    expect(lines![2].map((s) => s.text).join("")).toBe("const a = '<b>&';");
    expect(lines![2].find((s) => s.text === "const")?.cls).toBe("tok-keyword");
    expect(lines![2].find((s) => s.text.includes("<b>"))?.cls).toBe("tok-string");
  });

  it("rechaza cualquier HTML que no sea un span de highlight.js", () => {
    expect(toLines('<img src=x onerror="alert(1)">')).toBeNull();
    expect(toLines('<span class="hljs-string">x')).toBeNull();
    expect(toLines("</span>")).toBeNull();
    expect(toLines("a &lt; b")).toEqual([[{ text: "a < b" }]]);
  });
});
