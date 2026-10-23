import { describe, expect, it } from "vitest";
import { describeServer, sshAliasCommand, sshServerCommand, validateServer, type ServerFields } from "./ssh";

const server = (patch: Partial<ServerFields> = {}): ServerFields => ({ name: "prod", user: "deploy", host: "10.0.0.5", port: 22, identityFile: "", ...patch });

describe("validateServer", () => {
  it("accepts domains, IPs and IPv6 in brackets", () => {
    for (const host of ["servidor.ejemplo.mx", "10.0.0.5", "[::1]", "web-1"]) expect(validateServer(server({ host }))).toEqual({});
  });

  it("rejects what ssh would read as an option or the shell as code", () => {
    for (const host of ["-oProxyCommand=evil", "a b", "a;rm -rf ~", "$(id)", ""]) expect(validateServer(server({ host })).host).toBeTruthy();
    expect(validateServer(server({ user: "-x" })).user).toBeTruthy();
    expect(validateServer(server({ port: 70000 })).port).toBeTruthy();
    expect(validateServer(server({ identityFile: "llave" })).identityFile).toBeTruthy();
    expect(validateServer(server({ name: " " })).name).toBeTruthy();
  });
});

describe("ssh commands", () => {
  it("puts -- before the destination", () => {
    expect(sshServerCommand(server())).toBe("ssh -- 'deploy@10.0.0.5'");
    expect(sshServerCommand(server({ port: 2222, identityFile: "~/.ssh/id_ed25519", user: "" }))).toBe("ssh -p 2222 -i ~/'.ssh/id_ed25519' -- '10.0.0.5'");
    expect(sshAliasCommand("prod")).toBe("ssh -- 'prod'");
  });

  it("refuses invalid input instead of running it", () => {
    expect(sshServerCommand(server({ host: "-oProxyCommand=sh" }))).toBeNull();
    expect(sshAliasCommand("-oProxyCommand=sh")).toBeNull();
    expect(sshAliasCommand("a;b")).toBeNull();
  });

  it("describes a server compactly", () => {
    expect(describeServer("deploy", "10.0.0.5", 2222)).toBe("deploy@10.0.0.5:2222");
    expect(describeServer(null, "web", 22)).toBe("web");
  });
});
