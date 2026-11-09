import { describe, expect, it } from "vitest";
import { imageKind, lineFromFragment, linkKind, parseMarkdown, resolveRelative, slugify, type MdNode } from "./markdown";

/** Árbol compacto para comparar: `tag[attrs](hijos)` y el texto tal cual. */
function show(nodes: MdNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === "text") return n.text;
      const attrs = Object.entries(n.attrs)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",");
      return `${n.tag}${attrs ? `[${attrs}]` : ""}(${show(n.children)})`;
    })
    .join("");
}

describe("parseMarkdown", () => {
  it("builds headings with GitHub-style anchors, unique per document", () => {
    expect(show(parseMarkdown("# Cómo instalar\n\n## Uso\n\n## Uso"))).toBe(
      "h1[id=cómo-instalar](Cómo instalar)h2[id=uso](Uso)h2[id=uso-1](Uso)",
    );
  });

  it("keeps raw HTML as text: nothing reaches the DOM unescaped", () => {
    const out = show(parseMarkdown('<script>alert(1)</script>\n\nhola <img src=x onerror="alert(1)">'));
    expect(out).toContain("<script>alert(1)</script>");
    expect(out).not.toMatch(/img\[/);
  });

  it("drops dangerous link and image targets but keeps the text", () => {
    // markdown-it ya no los convierte en enlace (quedan como texto); el árbol los filtraría igual.
    expect(show(parseMarkdown("[clic](javascript:alert(1)) [ok](https://a.com)"))).toBe("p([clic](javascript:alert(1)) a[href=https://a.com](ok))");
    expect(show(parseMarkdown("![x](file:///etc/passwd)"))).toBe("p(![x](file:///etc/passwd))");
    expect(show(parseMarkdown("![logo](img/logo.png)"))).toBe("p(img[src=img/logo.png,alt=logo]())");
  });

  it("renders lists, task lists, code fences and tables", () => {
    expect(show(parseMarkdown("- [x] hecho\n- [ ] falta"))).toBe("ul(li(input[checked=true]()hecho)li(input[checked=false]()falta))");
    expect(show(parseMarkdown("3. tres\n4. cuatro"))).toBe("ol[start=3](li(tres)li(cuatro))");
    expect(show(parseMarkdown("```ts\nconst a = 1;\n```"))).toBe("pre(code[lang=ts](const a = 1;))");
    expect(show(parseMarkdown("| a | b |\n|:-|-:|\n| 1 | 2 |"))).toBe(
      "table(thead(tr(th[align=left](a)th[align=right](b)))tbody(tr(td[align=left](1)td[align=right](2))))",
    );
  });

  it("links bare URLs and keeps inline code literal", () => {
    expect(show(parseMarkdown("ver https://termcode.dev y `rm -rf *`"))).toBe("p(ver a[href=https://termcode.dev](https://termcode.dev) y code(rm -rf *))");
  });
});

describe("links and images", () => {
  it("classifies hrefs", () => {
    expect(linkKind("https://a.com")).toBe("external");
    expect(linkKind("mailto:a@b.c")).toBe("external");
    expect(linkKind("#uso")).toBe("anchor");
    expect(linkKind("docs/a.md#L3")).toBe("relative");
    for (const bad of ["javascript:alert(1)", " JaVaScRiPt:x", "file:///etc", "data:text/html,x", "//evil.com", "vbscript:x", ""]) {
      expect(linkKind(bad)).toBe("blocked");
    }
  });

  it("classifies image sources", () => {
    expect(imageKind("img/logo.png")).toBe("relative");
    expect(imageKind("data:image/png;base64,AAAA")).toBe("data");
    expect(imageKind("data:image/svg+xml;base64,AAAA")).toBe("blocked");
    expect(imageKind("https://a.com/x.png")).toBe("remote");
  });

  it("resolves relative links inside the project only", () => {
    expect(resolveRelative("docs/guia/uso.md", "../api.md#L12")).toEqual({ path: "docs/api.md", fragment: "L12" });
    expect(resolveRelative("README.md", "./src/App%20Main.tsx")).toEqual({ path: "src/App Main.tsx", fragment: "" });
    expect(resolveRelative("docs/a.md", "/LICENSE")).toEqual({ path: "LICENSE", fragment: "" });
    expect(resolveRelative("README.md", "../../etc/passwd")).toBeNull();
    expect(lineFromFragment("L12")).toBe(12);
    expect(lineFromFragment("uso")).toBeUndefined();
  });

  it("slugifies like GitHub", () => {
    expect(slugify("¿Qué es termCode?")).toBe("qué-es-termcode");
    expect(slugify("API  v2")).toBe("api--v2");
  });
});
