#!/usr/bin/env node

const passthroughArgs = new Set([
  "graph",
  "clients",
  "wrapped",
  "export",
  "status",
  "doctor",
  "login",
  "logout",
  "submit",
  "web",
]);

const firstArg = process.argv[2];
if (!firstArg || (!firstArg.startsWith("-") && !passthroughArgs.has(firstArg))) {
  process.argv.splice(2, 0, "web");
} else if (firstArg?.startsWith("--") && firstArg !== "--help" && firstArg !== "--version") {
  process.argv.splice(2, 0, "web");
}

await import("./dist/index.js");
