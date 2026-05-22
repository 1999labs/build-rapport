/**
 * `build-rapport` CLI.
 *
 * The single subcommand is `init`: prompts for an email, registers an agent
 * against the Rapport API, writes credentials into `.env` in the current
 * working directory, installs the SDK, and prints the snippet to drop into
 * the user's agent.
 *
 * Argv is parsed by hand — one fixed subcommand with no options means
 * pulling in commander or minimist would add 50KB+ for no behavioral gain.
 * If more commands land here, swap to commander then.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

const BASE_URL = process.env.RAPPORT_BASE_URL ?? "https://rapport.sh";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function init(): Promise<void> {
  console.log("Setting up Rapport...");

  if (existsSync(join(process.cwd(), "pnpm-workspace.yaml"))) {
    console.log("");
    console.log(
      "⚠ You appear to be inside a pnpm monorepo (pnpm-workspace.yaml present).",
    );
    console.log(
      "  If this monorepo already declares build-rapport as a workspace package,",
    );
    console.log(
      "  the SDK is available without installing it. Otherwise the install step",
    );
    console.log("  below may behave unexpectedly inside a workspace.");
    console.log("");
  }

  const rl = createInterface({ input: stdin, output: stdout });
  let email: string;
  try {
    email = (await rl.question("Enter your email: ")).trim();
  } finally {
    rl.close();
  }

  if (!EMAIL_RE.test(email)) {
    console.error("✗ That doesn't look like a valid email address.");
    process.exit(1);
  }

  const agentId = await register(email);
  writeEnv(agentId);
  const installed = installSdk();
  printSuccess(agentId, installed);
}

async function register(email: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/api/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
  } catch (err) {
    console.error(`✗ Could not reach the Rapport API: ${(err as Error).message}`);
    process.exit(1);
  }

  const body = await response.json().catch(() => ({}) as unknown);
  if (!response.ok) {
    const msg =
      typeof (body as { error?: unknown })?.error === "string"
        ? (body as { error: string }).error
        : `HTTP ${response.status}`;
    console.error(`✗ Registration failed: ${msg}`);
    process.exit(1);
  }
  const agentId = (body as { agent_id?: unknown })?.agent_id;
  if (typeof agentId !== "string") {
    console.error("✗ Registration response missing agent_id.");
    process.exit(1);
  }
  return agentId;
}

/**
 * Write `RAPPORT_API_KEY=` and `RAPPORT_AGENT_ID=<agentId>` into `./.env`.
 * If those keys already exist, leave the file alone and tell the user.
 */
function writeEnv(agentId: string): void {
  const envPath = join(process.cwd(), ".env");
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";

  if (/^RAPPORT_(API_KEY|AGENT_ID)=/m.test(existing)) {
    console.log("⚠ .env already contains RAPPORT_ variables; not overwriting.");
    console.log(`  Update manually: RAPPORT_AGENT_ID=${agentId}`);
    return;
  }

  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  // Agent id first so when the operator pastes the API key from their email
  // they're filling in the visually-blank line below the populated one.
  const block =
    `# Rapport\n` +
    `RAPPORT_AGENT_ID=${agentId}\n` +
    `RAPPORT_API_KEY=    # check your email\n`;
  writeFileSync(envPath, `${existing}${separator}${block}`, "utf-8");
}

/** Install the SDK into the user's project. Returns whether it succeeded.
 *
 * The explicit `--registry` flag forces a fetch from the public npm registry
 * even if the operator is sitting inside a workspace whose local config would
 * otherwise interfere with resolution. */
function installSdk(): boolean {
  const result = spawnSync(
    "npm",
    ["install", "build-rapport", "--registry", "https://registry.npmjs.org"],
    { stdio: "inherit" },
  );
  return result.status === 0;
}

function printSuccess(agentId: string, installed: boolean): void {
  console.log("");
  console.log(`✓ Agent ${agentId} registered`);
  console.log("✓ Check your email for your API key");
  if (installed) {
    console.log("✓ SDK installed");
  } else {
    console.log("⚠ SDK install failed; run manually: npm install build-rapport");
  }
  console.log("");
  console.log("Add to your agent:");
  console.log("");
  console.log("  import { Rapport } from 'build-rapport'");
  console.log("  const rapport = new Rapport({");
  console.log("    apiKey: process.env.RAPPORT_API_KEY,");
  console.log("    agentId: process.env.RAPPORT_AGENT_ID");
  console.log("  })");
  console.log("  rapport.intercept()");
}

function usage(): void {
  console.log("Usage: build-rapport <command>");
  console.log("");
  console.log("Commands:");
  console.log("  init    Register an agent, write .env, install the SDK");
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "init") {
    await init();
    return;
  }
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    usage();
    return;
  }
  console.error(`Unknown command: ${cmd}`);
  console.error("");
  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
