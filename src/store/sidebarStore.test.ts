import { beforeEach, describe, expect, it } from "vitest";
import { MAX_RECENT, placesToShow, sanitizeSidebar, useSidebarStore } from "./sidebarStore";

const HOME = "/Users/jorge";
const store = () => useSidebarStore.getState();

beforeEach(() => store().hydrate({}));

describe("visit", () => {
  it("keeps the latest folder first, without duplicates", () => {
    store().visit("/a", HOME, 1);
    store().visit("/b", HOME, 2);
    store().visit("/a/", HOME, 3);
    expect(store().recent).toEqual([
      { path: "/a/", at: 3 },
      { path: "/b", at: 2 },
    ]);
  });

  it("does not list home or the root: they are always one cd away", () => {
    store().visit(HOME, HOME);
    store().visit(`${HOME}/`, HOME);
    store().visit("/", HOME);
    store().visit("C:\\", HOME);
    expect(store().recent).toEqual([]);
  });

  it("does not change anything when every prompt repeats the same folder", () => {
    store().visit("/a", HOME, 1);
    const before = store().recent;
    store().visit("/a", HOME, 2);
    expect(store().recent).toBe(before);
  });

  it("remembers at most MAX_RECENT", () => {
    for (let i = 0; i < MAX_RECENT + 3; i++) store().visit(`/p${i}`, HOME, i);
    expect(store().recent).toHaveLength(MAX_RECENT);
    expect(store().recent[0].path).toBe(`/p${MAX_RECENT + 2}`);
  });
});

describe("placesToShow", () => {
  it("shows pinned first, then the recent ones that are not pinned", () => {
    store().visit("/a", HOME, 1);
    store().visit("/b", HOME, 2);
    store().visit("/c", HOME, 3);
    store().togglePin("/a");
    const shown = placesToShow(store(), 2);
    expect(shown.map((p) => [p.path, p.pinned])).toEqual([
      ["/a", true],
      ["/c", false],
    ]);
  });

  it("never hides a pinned folder because of the limit", () => {
    ["/x", "/y", "/z"].forEach((p) => store().togglePin(p));
    expect(placesToShow(store(), 1)).toHaveLength(3);
  });

  it("unpins on the second toggle and forgets everywhere", () => {
    store().togglePin("/x");
    store().togglePin("/x/");
    expect(store().pinned).toEqual([]);
    store().visit("/y", HOME);
    store().togglePin("/y");
    store().forget("/y");
    expect(store().recent).toEqual([]);
    expect(store().pinned).toEqual([]);
  });
});

describe("sanitizeSidebar", () => {
  it("keeps only valid data from disk", () => {
    expect(
      sanitizeSidebar({
        recent: [{ path: "/ok", at: 1 }, { path: 3, at: 1 }, { path: "/no-at" }, null],
        pinned: ["/p", "/p", 7, ""],
        collapsed: { places: true, system: "yes", other: true },
      }),
    ).toEqual({ recent: [{ path: "/ok", at: 1 }], pinned: ["/p"], collapsed: { places: true }, servers: [], trustedWorkspaces: [] });
    expect(sanitizeSidebar("basura")).toEqual({ recent: [], pinned: [], collapsed: {}, servers: [], trustedWorkspaces: [] });
  });

  it("trusts one version of a workspace per folder", () => {
    const hash = (c: string) => c.repeat(64);
    store().trustWorkspace(`/repo#${hash("a")}`);
    store().trustWorkspace(`/otro#${hash("b")}`);
    store().trustWorkspace(`/repo#${hash("c")}`);
    expect(store().trustedWorkspaces).toEqual([`/otro#${hash("b")}`, `/repo#${hash("c")}`]);
    expect(sanitizeSidebar({ trustedWorkspaces: ["/x#abc", `/y#${hash("d")}`] }).trustedWorkspaces).toEqual([`/y#${hash("d")}`]);
  });

  it("drops saved servers that would not be safe to run", () => {
    const ok = { id: "a", name: "prod", user: "deploy", host: "10.0.0.5", port: 22, identityFile: "" };
    const evil = { ...ok, id: "b", host: "-oProxyCommand=sh" };
    expect(sanitizeSidebar({ servers: [ok, evil, { id: "c" }] }).servers).toEqual([ok]);
  });
});
