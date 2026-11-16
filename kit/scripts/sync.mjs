#!/usr/bin/env node
// Copy the shared kit into plugins/<id>/kit/ as generated files.
//
//   node kit/scripts/sync.mjs review-editor        # one or more plugin ids
//   node kit/scripts/sync.mjs --all                # every plugin that already has kit/
//   node kit/scripts/sync.mjs --check --all        # exit 1 if any copy is stale
//
// Why copy: bb's build only runs Tailwind over files inside the plugin
// directory, and esbuild resolves a file's bare imports (motion, radix) from
// that file's own location. A kit outside the plugin compiles without its
// classes and cannot find its dependencies. See docs/CONVENTIONS.md.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const kitDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(kitDir, "..");
const pluginsDir = join(root, "plugins");
const SKIP = new Set(["scripts", "node_modules", "README.md", "tsconfig.json"]);
const MARK = "GENERATED from /kit by kit/scripts/sync.mjs";

const args = process.argv.slice(2);
const check = args.includes("--check");
const all = args.includes("--all");
let ids = args.filter((a) => !a.startsWith("--"));
if (all) {
  ids = readdirSync(pluginsDir).filter((id) => existsSync(join(pluginsDir, id, "kit")));
}
if (ids.length === 0) {
  console.error("usage: node kit/scripts/sync.mjs <plugin-id...> | --all [--check]");
  process.exit(2);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(full);
  }
  return out.sort();
}

const sources = walk(kitDir);
const hash = createHash("sha256");
for (const file of sources) hash.update(relative(kitDir, file)).update(readFileSync(file));
const version = hash.digest("hex").slice(0, 12);

const header = (file) =>
  file.endsWith(".css")
    ? `/* ${MARK} (kit ${version}). Do not edit; change /kit and re-sync. */\n`
    : `// ${MARK} (kit ${version}). Do not edit; change /kit and re-sync.\n`;

let stale = 0;
for (const id of ids) {
  const pluginDir = join(pluginsDir, id);
  if (!existsSync(join(pluginDir, "package.json"))) {
    console.error(`${id}: no plugins/${id}/package.json`);
    process.exitCode = 1;
    continue;
  }
  const target = join(pluginDir, "kit");
  const versionFile = join(target, "VERSION");
  const current = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : null;
  if (check) {
    if (current !== version) {
      console.log(`${id}: stale (has ${current ?? "none"}, kit is ${version})`);
      stale++;
    } else console.log(`${id}: up to date (${version})`);
    continue;
  }

  // Remove generated files that no longer exist in the source.
  if (existsSync(target)) {
    for (const file of walkAll(target)) {
      const rel = relative(target, file);
      const text = readFileSync(file, "utf8");
      if (text.includes(MARK) && !existsSync(join(kitDir, rel))) rmSync(file);
    }
  }
  for (const file of sources) {
    const rel = relative(kitDir, file);
    const out = join(target, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, header(file) + readFileSync(file, "utf8"));
  }
  writeFileSync(versionFile, `${version}\n`);
  console.log(`${id}: kit ${version} (${sources.length} files) -> plugins/${id}/kit/`);
  for (const problem of prerequisites(pluginDir)) console.log(`  ! ${problem}`);
}
if (check && stale > 0) process.exit(1);

function walkAll(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkAll(full));
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(full);
  }
  return out;
}

function prerequisites(pluginDir) {
  const problems = [];
  const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  const dev = pkg.devDependencies ?? {};
  if (!deps.motion) problems.push('motion missing from dependencies: npm install motion');
  if (!deps["@radix-ui/react-slot"]) problems.push("@radix-ui/react-slot missing from dependencies: npm install @radix-ui/react-slot");
  if (!dev["@radix-ui/react-popover"]) problems.push("@radix-ui/react-popover missing from devDependencies (host-shimmed, types only)");
  if (!dev.sonner) problems.push("sonner missing from devDependencies (host-shimmed, types only)");
  for (const f of ["components/ui/button.tsx", "components/ui/dialog.tsx", "components/ui/icon.tsx", "lib/utils.ts", "lib/portal-scope.ts"]) {
    if (!existsSync(join(pluginDir, f))) problems.push(`${f} missing: the bb scaffold vendors it (npx shadcn add @bb/...)`);
  }
  try {
    const tsconfig = readFileSync(join(pluginDir, "tsconfig.json"), "utf8");
    if (!/"kit"/.test(tsconfig)) problems.push('tsconfig.json "include" lacks "kit"');
  } catch {
    problems.push("no tsconfig.json");
  }
  return problems;
}
