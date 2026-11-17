// What a new machine is missing: the editor binary and its version, the
// bridge directory, the language tools the owner's Helix config expects, and
// the font the Ghostty config names. Read only; every failing check carries
// the command that fixes it.
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { DoctorCheck, GhosttyConfig, InstanceSummary } from "../shared/host-contract";
import { PROTOCOL_VERSION } from "../shared/protocol";

export const INSTALL_COMMAND =
  "git clone -b bb-bridge https://github.com/marianodsr/helix.git ~/src/helix-bb && ~/src/helix-bb/bb-bridge/install.sh";

export function resolveExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const executable = (path: string) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  };
  if (name.includes("/")) return executable(name) ? name : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (executable(candidate)) return candidate;
  }
  return null;
}

function run(file: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}

const fontTokens = (family: string) =>
  family
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);

/** Whether a font family is installed: fontconfig when present, else font file names. */
export async function fontInstalled(family: string): Promise<boolean> {
  const fcList = resolveExecutable("fc-list");
  if (fcList) {
    const out = await run(fcList, [":", "family"]);
    if (out !== null) {
      const wanted = family.toLowerCase();
      if (out.split("\n").some((line) => line.split(",").some((name) => name.trim().toLowerCase() === wanted))) return true;
    }
  }
  const tokens = fontTokens(family);
  const dirs = [join(homedir(), "Library/Fonts"), "/Library/Fonts", "/System/Library/Fonts", join(homedir(), ".local/share/fonts"), "/usr/share/fonts"];
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const name of names) {
      const flat = String(name).toLowerCase().replace(/[^a-z0-9]/gu, "");
      if (/\.(ttf|otf|ttc)$/iu.test(String(name)) && tokens.every((token) => flat.includes(token))) return true;
    }
  }
  return false;
}

export async function runDoctor(input: {
  bridgeDir: string;
  hxbPath: string;
  fontFamily: string | null;
  instances: InstanceSummary[];
}): Promise<{ checks: DoctorCheck[]; hxbResolved: string | null; hxbVersion: string | null }> {
  const checks: DoctorCheck[] = [];
  const hxb = input.hxbPath.trim() || "hxb";
  const resolved = resolveExecutable(hxb);
  let version: string | null = null;
  if (!resolved) {
    checks.push({
      id: "binary",
      label: "Editor binary",
      ok: false,
      level: "error",
      detail: hxb.includes("/") ? `${hxb} does not exist or is not executable` : `\`${hxb}\` is not on PATH (${(process.env.PATH ?? "").split(delimiter).length} directories searched)`,
      fix: `Install the Helix fork: ${INSTALL_COMMAND}. Or point the "Editor binary" setting at it: bb plugin config helix-bridge set hxbPath /path/to/hxb`,
    });
  } else {
    version = await run(resolved, ["--version"]);
    checks.push({
      id: "binary",
      label: "Editor binary",
      ok: version !== null,
      level: version !== null ? "ok" : "error",
      detail: version !== null ? `${resolved}: ${version}` : `${resolved} did not answer --version`,
      fix: version !== null ? null : `Reinstall the fork: ${INSTALL_COMMAND}`,
    });
  }

  const connected = input.instances.filter((i) => i.status === "connected" || i.status === "incompatible");
  if (connected.length === 0) {
    checks.push({ id: "protocol", label: "Bridge protocol", ok: true, level: "warn", detail: "no running instance to ask; start hxb to check", fix: resolved ? `Run ${hxb} in a terminal, then run bb hx doctor again` : null });
  } else {
    const bad = connected.filter((i) => i.protocol !== PROTOCOL_VERSION);
    checks.push({
      id: "protocol",
      label: "Bridge protocol",
      ok: bad.length === 0,
      level: bad.length === 0 ? "ok" : "error",
      detail: bad.length === 0 ? `version ${PROTOCOL_VERSION} on ${connected.length} running instance${connected.length === 1 ? "" : "s"}` : bad.map((i) => `pid ${i.pid} speaks protocol ${i.protocol}`).join("; "),
      fix: bad.length === 0 ? null : `Update the fork and this plugin together: ${INSTALL_COMMAND}`,
    });
  }

  if (!existsSync(input.bridgeDir)) {
    checks.push({ id: "socketDir", label: "Bridge directory", ok: true, level: "warn", detail: `${input.bridgeDir} does not exist yet; Helix creates it when it starts`, fix: null });
  } else {
    const mode = statSync(input.bridgeDir).mode & 0o777;
    const sockets = readdirSync(input.bridgeDir).filter((n) => n.endsWith(".json")).length;
    checks.push({
      id: "socketDir",
      label: "Bridge directory",
      ok: (mode & 0o077) === 0,
      level: (mode & 0o077) === 0 ? "ok" : "warn",
      detail: `${input.bridgeDir}, mode ${mode.toString(8)}, ${sockets} registry file${sockets === 1 ? "" : "s"}`,
      fix: (mode & 0o077) === 0 ? null : `chmod 700 ${input.bridgeDir}`,
    });
  }

  for (const [tool, fix] of [
    ["gopls", "go install golang.org/x/tools/gopls@latest"],
    ["goimports", "go install golang.org/x/tools/cmd/goimports@latest"],
  ] as const) {
    const path = resolveExecutable(tool);
    checks.push({ id: tool, label: tool, ok: path !== null, level: path ? "ok" : "warn", detail: path ?? `not on PATH; Go files get no ${tool === "gopls" ? "language server" : "import fixing"}`, fix: path ? null : fix });
  }

  if (input.fontFamily) {
    const installed = await fontInstalled(input.fontFamily);
    checks.push({
      id: "font",
      label: "Editor font",
      ok: installed,
      level: installed ? "ok" : "warn",
      detail: installed ? `${input.fontFamily} is installed` : `${input.fontFamily} (from the Ghostty config) is not installed; the editor falls back to the system monospace font`,
      fix: installed ? null : `brew install --cask font-${fontTokens(input.fontFamily).filter((t) => t !== "mono" && t !== "font").join("-")}-nerd-font`,
    });
  }
  return { checks, hxbResolved: resolved, hxbVersion: version };
}

/** Ghostty's config, read only: `$XDG_CONFIG_HOME/ghostty/config`, `~/.config/ghostty/config`, then the macOS app-support path. */
export function readGhosttyConfig(env: NodeJS.ProcessEnv = process.env): GhosttyConfig {
  const home = env.HOME || homedir();
  const candidates = [
    ...(env.XDG_CONFIG_HOME ? [join(env.XDG_CONFIG_HOME, "ghostty", "config")] : []),
    join(home, ".config", "ghostty", "config"),
    join(home, "Library", "Application Support", "com.mitchellh.ghostty", "config"),
  ];
  const path = candidates.find((p) => existsSync(p)) ?? candidates[0]!;
  const config: GhosttyConfig = {
    path,
    found: false,
    fontFamily: null,
    fontSize: null,
    fontStyle: null,
    boldIsBright: null,
    // Absent file: Option as Alt (the owner's choice and what Helix needs).
    optionAsAlt: "true",
    theme: null,
    background: null,
    foreground: null,
  };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return config;
  }
  config.found = true;
  // Present file without the key: Ghostty's own default, false.
  config.optionAsAlt = "false";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^"(.*)"$/u, "$1");
    switch (key) {
      case "font-family":
        // The first font-family wins as the primary; later ones are fallbacks.
        if (config.fontFamily === null && value) config.fontFamily = value;
        break;
      case "font-size": {
        const size = Number(value);
        if (Number.isFinite(size) && size > 0) config.fontSize = size;
        break;
      }
      case "font-style":
        config.fontStyle = value || null;
        break;
      case "bold-is-bright":
        config.boldIsBright = value === "true";
        break;
      case "macos-option-as-alt":
        if (value === "true" || value === "false" || value === "left" || value === "right") config.optionAsAlt = value;
        break;
      case "theme":
        config.theme = value || null;
        break;
      case "background":
        config.background = value || null;
        break;
      case "foreground":
        config.foreground = value || null;
        break;
    }
  }
  return config;
}
