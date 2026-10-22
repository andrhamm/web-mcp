#!/usr/bin/env node
// Stands in for the `claude` binary in tests, driven by env:
//   FAKE_CLAUDE_OUT       file whose contents go to stdout (stream-json lines); unset prints nothing
//   FAKE_CLAUDE_LOG       file that gets one JSON line per call: argv, stdin, cwd and selected env
//   FAKE_CLAUDE_STDERR    text written to stderr
//   FAKE_CLAUDE_SLEEP_MS  delay before answering
//   FAKE_CLAUDE_SIGNED_OUT  makes `auth status` report signed out
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: !process.env.FAKE_CLAUDE_SIGNED_OUT }));
  process.exit(0);
}
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_LOG)
    appendFileSync(
      process.env.FAKE_CLAUDE_LOG,
      JSON.stringify({
        args,
        stdin,
        cwd: process.cwd(),
        claudecode: process.env.CLAUDECODE ?? null,
        apiKey: process.env.ANTHROPIC_API_KEY ?? null,
      }) + "\n",
    );
  setTimeout(() => {
    if (process.env.FAKE_CLAUDE_STDERR) process.stderr.write(process.env.FAKE_CLAUDE_STDERR);
    if (process.env.FAKE_CLAUDE_OUT) process.stdout.write(readFileSync(process.env.FAKE_CLAUDE_OUT, "utf8"));
  }, Number(process.env.FAKE_CLAUDE_SLEEP_MS) || 0);
});
