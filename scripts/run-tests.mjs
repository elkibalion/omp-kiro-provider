import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const buildDir = mkdtempSync(join(tmpdir(), "pi-kiro-provider-test-"));
const tscPath = join(root, "node_modules", "typescript", "bin", "tsc");

function writeNodeModulesTypeScriptLoader(path) {
  writeFileSync(path, `
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const typescript = require(${JSON.stringify(tscPath.replace(/[/\\\\]bin[/\\\\]tsc$/, ""))});
const bunShimUrl = "data:text/javascript," + encodeURIComponent([
  "export const YAML = { parse() { return {}; }, stringify(value) { return JSON.stringify(value); } };",
  "export const JSONC = { parse() { return {}; }, stringify(value) { return JSON.stringify(value); } };",
  "export class Glob { constructor() {} async *scan() {} }",
  "export const $ = () => { throw new Error('Bun shell is unavailable in Node test mode.'); };",
  "export const Database = class { constructor() { throw new Error('Bun SQLite is unavailable in Node test mode.'); } };",
  "export const FFIType = {}; export const dlopen = () => { throw new Error('Bun FFI is unavailable in Node test mode.'); }; export const ptr = () => 0;",
].join("\\n"));
const nativeShimUrl = "data:text/javascript," + encodeURIComponent([
  "export class FileLock { static tryAcquire() { return { acquired: true, release() {} }; } release() {} }",
  "export class Process {}",
  "export const ProcessStatus = {};",
].join("\\n"));

function isBunSpecifier(specifier) {
  return specifier === "bun" || specifier.startsWith("bun:");
}

function bunShimFor(specifier) {
  return specifier === "bun" || specifier === "bun:sqlite" || specifier === "bun:ffi" || specifier === "bun:jsc" ? bunShimUrl : undefined;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@oh-my-pi/pi-natives") return { url: nativeShimUrl, shortCircuit: true };
  const bunShim = bunShimFor(specifier);
  if (bunShim) return { url: bunShim, shortCircuit: true };
  if (isBunSpecifier(specifier)) return { url: bunShimUrl, shortCircuit: true };

  if ((specifier.startsWith(".") || specifier.startsWith("/")) && context.parentURL?.includes("/node_modules/")) {
    const baseSpecifier = specifier.endsWith(".js") ? specifier.slice(0, -3) : specifier;
    for (const candidateSpecifier of [baseSpecifier + ".ts", baseSpecifier + "/index.ts"]) {
      const candidate = new URL(candidateSpecifier, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context, nextResolve);
    }
  }
  return nextResolve(specifier, context, nextResolve);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".json") && url.includes("/node_modules/")) {
    const value = JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
    const namedExports = Object.entries(value)
      .filter(([name]) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))
      .map(([name, entry]) => "export const " + name + " = " + JSON.stringify(entry) + ";")
      .join("\\n");
    return { format: "module", source: "export default " + JSON.stringify(value) + ";\\n" + namedExports, shortCircuit: true };
  }
  if (/\.(md|html)$/.test(url) && url.includes("/node_modules/")) {
    const source = readFileSync(fileURLToPath(url), "utf8");
    return { format: "module", source: "export default " + JSON.stringify(source) + ";", shortCircuit: true };
  }
  if (url.endsWith(".ts") && url.includes("/node_modules/")) {
    const source = readFileSync(fileURLToPath(url), "utf8").replaceAll("import.meta.dir", JSON.stringify(fileURLToPath(new URL(".", url))));
    const output = typescript.transpileModule(source, {
      compilerOptions: {
        target: typescript.ScriptTarget.ES2022,
        module: typescript.ModuleKind.ESNext,
        sourceMap: false,
      },
      fileName: url,
    });
    return { format: "module", source: output.outputText, shortCircuit: true };
  }
  return nextLoad(url, context, nextLoad);
}
`, "utf-8");
}

const loaderPath = join(buildDir, "node-modules-typescript-loader.mjs");
writeNodeModulesTypeScriptLoader(loaderPath);

const preloadPath = join(buildDir, "node-modules-typescript-preload.mjs");
writeFileSync(preloadPath, [
  'import { register } from "node:module";',
  'import { pathToFileURL } from "node:url";',
  "const hash = (value) => { let result = 2166136261; for (const char of String(value)) result = Math.imul(result ^ char.charCodeAt(0), 16777619); return result >>> 0; };",
  "globalThis.Bun = { env: process.env, main: process.argv[1], hash, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };",
  `register(${JSON.stringify(loaderPath)}, pathToFileURL("./"));`,
].join("\n"), "utf-8");

let exitCode = 0;

try {
  const compile = spawnSync(process.execPath, [tscPath, "--outDir", buildDir, "--noEmit", "false"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env },
  });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) {
    exitCode = compile.status ?? 1;
  } else {
    writeFileSync(join(buildDir, "package.json"), JSON.stringify({ type: "module" }), "utf-8");
    const nodeModulesPath = join(root, "node_modules");
    if (existsSync(nodeModulesPath)) symlinkSync(nodeModulesPath, join(buildDir, "node_modules"), "junction");
    const test = spawnSync(process.execPath, ["--import", preloadPath, "--test", "tests/*.test.mjs"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, PI_KIRO_PROVIDER_BUILD_DIR: buildDir },
    });
    if (test.error) throw test.error;
    exitCode = test.status ?? 1;
  }
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}

process.exit(exitCode);
