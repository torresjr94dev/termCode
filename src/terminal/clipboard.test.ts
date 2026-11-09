import { describe, expect, it, vi } from "vitest";
import { fileUrisToPaths, needsRichPaste, resolvePaste, type ClipboardSnapshot, type PasteDeps } from "./clipboard";

const clip = (patch: Partial<ClipboardSnapshot>): ClipboardSnapshot => ({ text: "", uriList: "", images: [], hasFiles: false, ...patch });

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" });

function deps(patch: Partial<PasteDeps> = {}): PasteDeps {
  return {
    clipboardFiles: vi.fn(async () => []),
    saveImage: vi.fn(async () => "/cache/pegados/captura-1.png"),
    nativeImage: vi.fn(async () => null),
    ...patch,
  };
}

describe("needsRichPaste", () => {
  it("leaves plain text to xterm", () => {
    expect(needsRichPaste(clip({ text: "ls -la" }))).toBe(false);
  });

  it("takes files, empty text (a screenshot) and file URIs", () => {
    expect(needsRichPaste(clip({ hasFiles: true, text: "captura.png" }))).toBe(true);
    expect(needsRichPaste(clip({}))).toBe(true);
    expect(needsRichPaste(clip({ text: "x", uriList: "file:///tmp/a" }))).toBe(true);
  });
});

describe("fileUrisToPaths", () => {
  it("decodes file URIs and skips comments and other schemes", () => {
    const list = "# copiado en Nautilus\r\nfile:///home/jorge/Mi%20captura.png\r\nhttps://ejemplo.com/x.png\nfile://localhost/tmp/a\n";
    expect(fileUrisToPaths(list)).toEqual(["/home/jorge/Mi captura.png", "/tmp/a"]);
  });

  it("turns Windows drive URIs into Windows paths and refuses remote hosts", () => {
    expect(fileUrisToPaths("file:///C:/Users/Jorge%20Torres/a.png")).toEqual(["C:\\Users\\Jorge Torres\\a.png"]);
    expect(fileUrisToPaths("file://servidor/compartido/a.png")).toEqual([]);
  });
});

describe("resolvePaste", () => {
  it("prefers the files copied in Finder over the text that comes with them", async () => {
    const d = deps({ clipboardFiles: async () => ["/Users/j/Desktop/Captura 1.png"] });
    const out = await resolvePaste(clip({ hasFiles: true, text: "Captura 1.png", images: [png()] }), d);
    expect(out).toEqual({ kind: "paths", paths: ["/Users/j/Desktop/Captura 1.png"], savedImages: 0, failed: null });
    expect(d.saveImage).not.toHaveBeenCalled();
  });

  it("uses the URI list when the system clipboard gives nothing (Linux)", async () => {
    const out = await resolvePaste(clip({ hasFiles: true, uriList: "file:///home/j/a.png" }), deps());
    expect(out).toMatchObject({ kind: "paths", paths: ["/home/j/a.png"] });
  });

  it("pastes the text of a spreadsheet selection instead of its picture", async () => {
    const d = deps();
    const out = await resolvePaste(clip({ hasFiles: true, text: "a\tb", images: [png()] }), d);
    expect(out).toEqual({ kind: "text", text: "a\tb" });
    expect(d.saveImage).not.toHaveBeenCalled();
  });

  it("saves a screenshot and pastes its path", async () => {
    const d = deps();
    const out = await resolvePaste(clip({ hasFiles: true, images: [png()] }), d);
    expect(out).toEqual({ kind: "paths", paths: ["/cache/pegados/captura-1.png"], savedImages: 1, failed: null });
    expect(d.saveImage).toHaveBeenCalledWith(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it("reports why nothing could be pasted", async () => {
    const out = await resolvePaste(
      clip({ hasFiles: true, images: [png()] }),
      deps({
        clipboardFiles: async () => null,
        saveImage: async () => {
          throw new Error("La imagen pesa 40 MB");
        },
      }),
    );
    expect(out).toEqual({ kind: "nothing", failed: "La imagen pesa 40 MB" });
    expect(await resolvePaste(clip({}), deps())).toEqual({ kind: "nothing", failed: null });
  });

  it("falls back to the system clipboard image when the webview gave none", async () => {
    const d = deps({ nativeImage: async () => "/cache/pegados/captura-2.png" });
    expect(await resolvePaste(clip({ hasFiles: false }), d)).toEqual({
      kind: "paths",
      paths: ["/cache/pegados/captura-2.png"],
      savedImages: 1,
      failed: null,
    });
    // Si el webview sí dio la imagen, no se lee dos veces.
    const both = deps({ nativeImage: vi.fn(async () => "/x.png") });
    await resolvePaste(clip({ hasFiles: true, images: [png()] }), both);
    expect(both.nativeImage).not.toHaveBeenCalled();
  });

  it("survives a failing native clipboard read", async () => {
    const out = await resolvePaste(clip({ text: "hola" }), deps({ clipboardFiles: () => Promise.reject(new Error("x")) }));
    expect(out).toEqual({ kind: "text", text: "hola" });
  });
});
