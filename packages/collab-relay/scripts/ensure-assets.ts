#!/usr/bin/env bun

import { join } from "node:path";

const collabWebDir = join(import.meta.dir, "../../collab-web");
const distIndex = join(collabWebDir, "dist/index.html");

if (await Bun.file(distIndex).exists()) process.exit(0);

const proc = Bun.spawn(["bun", "run", "build"], {
	cwd: collabWebDir,
	stdout: "inherit",
	stderr: "inherit",
});
const exitCode = await proc.exited;
if (exitCode !== 0) process.exit(exitCode);
