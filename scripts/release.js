#!/usr/bin/env node
"use strict";

/**
 * One-command release build: bumps the version, compiles, and packages a .vsix with .env
 * bundled in automatically (no manual copy/verify step needed before sharing it).
 *
 * Usage:
 *   npm run release            bumps the patch version (x.y.Z+1)
 *   npm run release -- 2.0.0   sets an explicit version instead
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PKG_PATH = path.join(ROOT, "package.json");
const ENV_PATH = path.join(ROOT, ".env");

function bumpPatch(version) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`package.json version "${version}" isn't a plain x.y.z semver - bump it manually first.`);
  }
  const [major, minor, patch] = parts;
  return `${major}.${minor}.${patch + 1}`;
}

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
}

function verifyEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    console.error(`ERROR: ${ENV_PATH} does not exist.`);
    console.error("Create it with at least RETROPER_UPLOAD_URL before releasing - see .env.example.");
    process.exit(1);
  }
  const envContent = fs.readFileSync(ENV_PATH, "utf8");
  const uploadUrlMatch = envContent.match(/^RETROPER_UPLOAD_URL=(.+)$/m);
  if (!uploadUrlMatch || !uploadUrlMatch[1].trim()) {
    console.error("ERROR: RETROPER_UPLOAD_URL is missing or empty in .env.");
    console.error("Refusing to build a release that would silently fail to upload for everyone who installs it.");
    process.exit(1);
  }
  console.log(`.env OK - this exact file will be bundled into the .vsix:`);
  console.log(
    envContent
      .trim()
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n")
  );
}

function main() {
  const explicitVersion = process.argv.slice(2).find((a) => /^\d+\.\d+\.\d+$/.test(a));

  verifyEnv();

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
  const oldVersion = pkg.version;
  const newVersion = explicitVersion || bumpPatch(oldVersion);
  pkg.version = newVersion;
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`\nVersion: ${oldVersion} -> ${newVersion}`);

  const distDir = path.join(ROOT, "dist");
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }

  run("npx", ["tsc", "-p", "./"]);
  run("npx", ["vsce", "package", "--allow-package-env-file"]);

  const vsixName = `retroper-${newVersion}.vsix`;
  const vsixPath = path.join(ROOT, vsixName);
  if (!fs.existsSync(vsixPath)) {
    console.error(`ERROR: expected ${vsixPath} to exist after packaging, but it's missing.`);
    process.exit(1);
  }
  const sizeMb = (fs.statSync(vsixPath).size / (1024 * 1024)).toFixed(2);

  console.log(`\nDone: ${vsixName} (${sizeMb} MB)`);
  console.log("This file is ready to share as-is - .env is bundled in, no setup step needed before login.");
}

main();
