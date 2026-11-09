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
const {
  MAX_FILE_TABS,
  absolutePath,
  closeActiveFileTab,
  closeFileTabs,
  closeViewer,
  cycleFileTab,
  fileChangedOnDisk,
  hasUnsavedEdits,
  imageMime,
  openFile,
  openFileAbsolute,
  recentFiles,
  saveFile,
  setTabDirty,
  storeEditorSession,
  takeEditorSession,
} = await import("./project");

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
  useUiStore.setState({ confirm: null, toast: null });
  useProjectStore.setState({ cwd: "/repo", repo: null, viewer: null, fileTabs: [] });
});

const tabPaths = () => project().fileTabs.map((t) => `${t.root}:${t.path}${t.dirty ? "*" : ""}`);

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

  it("guarda contra la versión sobre la que se editó y detecta cambios ajenos", async () => {
    vi.mocked(gitApi.read).mockResolvedValue(preview("x", "v1"));
    await openFile("a.ts");
    vi.mocked(gitApi.writeFile).mockResolvedValueOnce("v2");
    expect(await saveFile("/repo", "a.ts", "y", "v1")).toEqual({ status: "saved", version: "v2" });
    expect(gitApi.writeFile).toHaveBeenLastCalledWith("/repo", "a.ts", "y", "v1");
    expect(project().viewer).toMatchObject({ preview: { text: "y", version: "v2" } });

    vi.mocked(gitApi.writeFile).mockRejectedValueOnce(new Error("El archivo cambió en disco desde que lo abriste."));
    expect(await saveFile("/repo", "a.ts", "z", "v2")).toEqual({ status: "conflict" });
    vi.mocked(gitApi.writeFile).mockResolvedValueOnce("v4");
    expect(await saveFile("/repo", "a.ts", "z", null)).toEqual({ status: "saved", version: "v4" });
    expect(gitApi.writeFile).toHaveBeenLastCalledWith("/repo", "a.ts", "z", null);

    vi.mocked(gitApi.fileVersion).mockResolvedValueOnce("v4");
    expect(await fileChangedOnDisk("/repo", "a.ts", "v4")).toBe(false);
    vi.mocked(gitApi.fileVersion).mockResolvedValueOnce("v5");
    expect(await fileChangedOnDisk("/repo", "a.ts", "v4")).toBe(true);
    vi.mocked(gitApi.fileVersion).mockRejectedValueOnce(new Error("no existe"));
    expect(await fileChangedOnDisk("/repo", "a.ts", "v4")).toBeNull();
  });

  it("guarda en la raíz del editor aunque el panel ya siga a otra carpeta", async () => {
    vi.mocked(gitApi.read).mockResolvedValue(preview("x", "v1"));
    await openFile("todo.md");
    // La terminal se fue a otra carpeta (sin repo) que también tiene un todo.md.
    useProjectStore.setState({ cwd: "/otra" });
    vi.mocked(gitApi.writeFile).mockResolvedValueOnce("v2");
    await saveFile("/repo", "todo.md", "mío", "v1");
    expect(gitApi.writeFile).toHaveBeenLastCalledWith("/repo", "todo.md", "mío", "v1");
    // El visor (de la otra raíz) no se toca con lo guardado en esta.
    expect(project().viewer).toMatchObject({ preview: { text: "x", version: "v1" } });
  });

  it("salta a la coincidencia de una búsqueda y cada salto cuenta aunque sea a la misma línea", async () => {
    vi.mocked(gitApi.read).mockResolvedValue(preview("uno\ndos\n"));
    await openFile("a.ts", { line: 2, column: 1, length: 2 });
    const first = project().viewer;
    expect(first).toMatchObject({ path: "a.ts", line: 2, column: 1, length: 2 });
    await openFile("a.ts", { line: 2, column: 1, length: 2 });
    const second = project().viewer;
    expect(second?.kind === "file" && first?.kind === "file" && second.jump !== first.jump).toBe(true);
    expect(recentFiles()[0]).toBe("a.ts");
  });
});

describe("pestañas del visor", () => {
  beforeEach(() => {
    vi.mocked(gitApi.read).mockImplementation(async (_root, path) => ({ ...preview(`contenido de ${path}`), absolute: `/repo/${path}` }));
  });

  it("cada archivo abre su pestaña, sin preguntar ni perder lo editado en las otras", async () => {
    await openFile("a.ts");
    setTabDirty("/repo", "a.ts", true);
    await openFile("b.ts");
    expect(useUiStore.getState().confirm).toBeNull();
    expect(tabPaths()).toEqual(["/repo:a.ts*", "/repo:b.ts"]);
    expect(project().viewer).toMatchObject({ path: "b.ts" });
    cycleFileTab(1);
    await vi.waitFor(() => expect(project().viewer).toMatchObject({ path: "a.ts" }));
  });

  it("Esc vuelve a las terminales sin cerrar pestañas (lo no guardado sigue ahí)", async () => {
    await openFile("a.ts");
    setTabDirty("/repo", "a.ts", true);
    closeViewer();
    expect(useUiStore.getState().confirm).toBeNull();
    expect(project().viewer).toBeNull();
    expect(hasUnsavedEdits()).toBe(true);
  });

  it("cerrar una pestaña con cambios pregunta; al cerrarla se pasa a la vecina", async () => {
    await openFile("a.ts");
    await openFile("b.ts");
    await openFile("c.ts");
    await openFile("b.ts");
    setTabDirty("/repo", "b.ts", true);

    closeActiveFileTab();
    await vi.waitFor(() => expect(useUiStore.getState().confirm?.confirmLabel).toBe("Cerrar sin guardar"));
    useUiStore.getState().resolveConfirm(false);
    await Promise.resolve();
    expect(tabPaths()).toContain("/repo:b.ts*");

    closeActiveFileTab();
    await vi.waitFor(() => expect(useUiStore.getState().confirm).not.toBeNull());
    useUiStore.getState().resolveConfirm(true);
    await vi.waitFor(() => expect(project().viewer).toMatchObject({ path: "c.ts" }));
    expect(tabPaths()).toEqual(["/repo:a.ts", "/repo:c.ts"]);
    expect(hasUnsavedEdits()).toBe(false);

    await closeFileTabs(["a.ts", "c.ts"]);
    expect(project().viewer).toBeNull();
    expect(tabPaths()).toEqual([]);
  });

  it("con demasiadas pestañas se cierra la más vieja que no tenga cambios", async () => {
    await openFile("f0.ts");
    setTabDirty("/repo", "f0.ts", true);
    for (let i = 1; i <= MAX_FILE_TABS; i++) await openFile(`f${i}.ts`);
    const paths = project().fileTabs.map((t) => t.path);
    expect(paths).toHaveLength(MAX_FILE_TABS);
    expect(paths).toContain("f0.ts");
    expect(paths).not.toContain("f1.ts");
  });

  it("otro repo no pierde lo que se editaba: la pestaña y su sesión esperan", async () => {
    await openFile("a.ts");
    setTabDirty("/repo", "a.ts", true);
    storeEditorSession("/repo", "a.ts", { session: { json: 1 }, version: "v1", dirty: true });
    useProjectStore.setState({ cwd: "/otro", viewer: null });
    await openFile("x.ts");
    expect(tabPaths()).toEqual(["/repo:a.ts*", "/otro:x.ts"]);
    expect(hasUnsavedEdits()).toBe(true);
    expect(takeEditorSession("/repo", "a.ts")).toEqual({ session: { json: 1 }, version: "v1", dirty: true });
    expect(takeEditorSession("/repo", "a.ts")).toBeUndefined();
  });
});
