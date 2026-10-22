import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../terminal/TerminalManager", () => ({
  terminalManager: { kill: vi.fn(), focus: vi.fn(), info: vi.fn(), paste: vi.fn(), knownCwd: vi.fn() },
}));

vi.mock("./git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git")>();
  return {
    ...actual,
    gitApi: {
      read: vi.fn(),
      readImage: vi.fn(),
      writeFile: vi.fn(),
      fileVersion: vi.fn(),
      status: vi.fn(async () => ({ branch: "main", head: "1", upstream: null, ahead: 0, behind: 0, changes: [], operation: null })),
      stashList: vi.fn(async () => []),
      ciStatus: vi.fn(async () => null),
    },
  };
});

const { gitApi } = await import("./git");
const { useProjectStore } = await import("../store/projectStore");
const { useUiStore } = await import("../store/uiStore");
const { absolutePath, closeViewer, confirmDiscard, fileChangedOnDisk, imageMime, openFile, openFileAbsolute, registerUnsaved, saveFile } =
  await import("./project");

const project = () => useProjectStore.getState();
const preview = (text: string, version = "v1") => ({
  text,
  size: text.length,
  truncated: false,
  binary: false,
  utf8: true,
  version,
  absolute: `/repo/${"a.ts"}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  registerUnsaved(null);
  useUiStore.setState({ confirm: null, toast: null });
  useProjectStore.setState({ cwd: "/repo", repo: null, viewer: null });
});

describe("visor de archivos", () => {
  it("abre rutas absolutas del proyecto, también con la raíz de Windows", async () => {
    vi.mocked(gitApi.read).mockResolvedValue(preview("x"));
    useProjectStore.setState({ cwd: "C:\\repo" });
    expect(absolutePath("src/a.ts")).toBe("C:\\repo\\src\\a.ts");
    expect(openFileAbsolute("C:\\otro\\a.ts")).toBe(false);
    expect(openFileAbsolute("C:\\repo")).toBe(false);
    // PowerShell conserva las mayúsculas que escribiste; el visor usa `/` como git.
    expect(openFileAbsolute("c:\\REPO\\src\\b.ts", 3)).toBe(true);
    await vi.waitFor(() => expect(project().viewer).toMatchObject({ path: "src/b.ts" }));

    useProjectStore.setState({ cwd: "/repo", viewer: null });
    expect(absolutePath("src/a.ts")).toBe("/repo/src/a.ts");
    expect(openFileAbsolute("/repository/a.ts")).toBe(false);
    expect(openFileAbsolute("/repo/src/a.ts")).toBe(true);
    await vi.waitFor(() => expect(project().viewer).toMatchObject({ path: "src/a.ts" }));
  });

  it("reconoce imágenes por extensión", () => {
    expect(imageMime("logo.PNG")).toBe("image/png");
    expect(imageMime("assets/icono.svg")).toBe("image/svg+xml");
    expect(imageMime("foto.jpeg")).toBe("image/jpeg");
    expect(imageMime("main.rs")).toBeNull();
    expect(imageMime("Makefile")).toBeNull();
  });

  it("abre texto, y el mismo archivo en otra línea no se relee", async () => {
    vi.mocked(gitApi.read).mockResolvedValue(preview("uno\ndos\n"));
    await openFile("a.ts");
    expect(project().viewer).toMatchObject({ kind: "file", path: "a.ts", preview: { text: "uno\ndos\n" } });
    await openFile("a.ts", 2);
    expect(gitApi.read).toHaveBeenCalledTimes(1);
    expect(project().viewer).toMatchObject({ path: "a.ts", line: 2 });
  });

  it("guarda con la versión que leyó y detecta cambios ajenos", async () => {
    vi.mocked(gitApi.read).mockResolvedValue(preview("x", "v1"));
    await openFile("a.ts");
    vi.mocked(gitApi.writeFile).mockResolvedValueOnce("v2");
    expect(await saveFile("a.ts", "y")).toBe("saved");
    expect(gitApi.writeFile).toHaveBeenLastCalledWith("/repo", "a.ts", "y", "v1");
    expect(project().viewer).toMatchObject({ preview: { text: "y", version: "v2" } });

    vi.mocked(gitApi.writeFile).mockRejectedValueOnce(new Error("El archivo cambió en disco desde que lo abriste."));
    expect(await saveFile("a.ts", "z")).toBe("conflict");
    vi.mocked(gitApi.writeFile).mockResolvedValueOnce("v4");
    expect(await saveFile("a.ts", "z", true)).toBe("saved");
    expect(gitApi.writeFile).toHaveBeenLastCalledWith("/repo", "a.ts", "z", null);

    vi.mocked(gitApi.fileVersion).mockResolvedValueOnce("v4");
    expect(await fileChangedOnDisk("a.ts")).toBe(false);
    vi.mocked(gitApi.fileVersion).mockResolvedValueOnce("v5");
    expect(await fileChangedOnDisk("a.ts")).toBe(true);
  });

  it("no pierde cambios sin preguntar", async () => {
    vi.mocked(gitApi.read).mockResolvedValue(preview("x"));
    await openFile("a.ts");
    registerUnsaved({ path: "a.ts", isDirty: () => true });

    // Cancelar: el visor sigue abierto.
    closeViewer();
    await vi.waitFor(() => expect(useUiStore.getState().confirm).not.toBeNull());
    useUiStore.getState().resolveConfirm(false);
    await Promise.resolve();
    expect(project().viewer?.kind).toBe("file");

    // Abrir otro archivo y aceptar: se descarta.
    const opening = openFile("b.ts");
    await vi.waitFor(() => expect(useUiStore.getState().confirm?.confirmLabel).toBe("Descartar cambios"));
    useUiStore.getState().resolveConfirm(true);
    await opening;
    expect(project().viewer).toMatchObject({ path: "b.ts" });
  });

  it("sin cambios no pregunta nada", async () => {
    registerUnsaved({ path: "a.ts", isDirty: () => false });
    expect(await confirmDiscard()).toBe(true);
    expect(useUiStore.getState().confirm).toBeNull();
  });
});
