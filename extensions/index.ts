import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, exec as execCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCallback);

const DEFAULT_BASE_URL = "http://127.0.0.1:3456";
const DEFAULT_PORT = Number(new URL(DEFAULT_BASE_URL).port) || 3456;
const HEALTH_TIMEOUT_MS = 3000;
const STARTUP_WAIT_MS = 6000;
const STARTUP_POLL_MS = 500;
const DEFAULT_MODEL_INPUT: ("text" | "image")[] = ["text", "image"];
const DEFAULT_CONTEXT_WINDOW = 200000;
const SONNET_COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } as const;
const OPUS_COST = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } as const;
const HAIKU_COST = { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } as const;

function getBaseUrl(): string {
  return process.env.MERIDIAN_BASE_URL || DEFAULT_BASE_URL;
}

function getPortFromBaseUrl(baseUrl: string): number {
  try {
    return Number(new URL(baseUrl).port) || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

function normalizeCwd(cwd: string): string {
  const normalized = cwd.trim().replace(/\\/g, "/");
  return normalized || ".";
}

const MERIDIAN_BASE_PROMPT = [
  "You are Claude Code operating through Meridian for pi, a terminal coding assistant. Help the user by analyzing code, proposing changes, and using the available tools when needed.",
  "",
  "Guidelines:",
  "- Be concise in your responses",
  "- Show file paths clearly when working with files",
  "- Prefer using the available tools over guessing",
  "- Follow project-specific instructions when present",
].join("\n");

const PROJECT_CONTEXT_END_REGEX =
  /\n(?:<available_skills>|Current date:|Current working directory:)/;
const CURRENT_DATE_LINE_REGEX = /^Current date:.*$/m;
const CURRENT_WORKING_DIRECTORY_LINE_REGEX =
  /^Current working directory:.*$/m;

function extractProjectContextSection(systemPrompt: string): string {
  const projectContextHeader = "# Project Context";
  const startIndex = systemPrompt.indexOf(projectContextHeader);
  if (startIndex === -1) return "";

  const remaining = systemPrompt.slice(startIndex);
  const endMatch = PROJECT_CONTEXT_END_REGEX.exec(remaining);
  const endIndex = endMatch ? endMatch.index : remaining.length;

  return remaining.slice(0, endIndex).trim();
}

function buildMeridianSafeSystemPrompt(
  originalSystemPrompt: string,
  cwd: string
): string {
  const projectContext = extractProjectContextSection(originalSystemPrompt);

  const currentDateLine =
    originalSystemPrompt.match(CURRENT_DATE_LINE_REGEX)?.[0] ||
    `Current date: ${new Date().toISOString().slice(0, 10)}`;

  const currentWorkingDirectoryLine =
    originalSystemPrompt.match(CURRENT_WORKING_DIRECTORY_LINE_REGEX)?.[0] ||
    `Current working directory: ${normalizeCwd(cwd)}`;

  return [
    MERIDIAN_BASE_PROMPT,
    projectContext,
    currentDateLine,
    currentWorkingDirectoryLine,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

interface MeridianHealth {
  status: string;
  auth?: {
    loggedIn: boolean;
    email?: string;
    subscriptionType?: string;
  };
  mode?: string;
  error?: string;
}

async function fetchHealth(
  baseUrl: string,
  signal?: AbortSignal
): Promise<MeridianHealth> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, HEALTH_TIMEOUT_MS);

  const onExternalAbort = () => controller.abort();
  if (signal) {
    signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: controller.signal,
    });
    const body = await response.text();
    let health: MeridianHealth;
    try {
      const parsed: unknown = JSON.parse(body);
      health = isValidHealth(parsed)
        ? parsed
        : { status: "error", error: `Unexpected response: ${body.slice(0, 200)}` };
    } catch {
      health = {
        status: "error",
        error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
      };
    }
    if (!response.ok && !health.error) {
      health.error = `HTTP ${response.status}`;
    }
    return health;
  } catch (err) {
    if (timedOut) {
      throw new Error(
        `Meridian health check timed out after ${HEALTH_TIMEOUT_MS}ms`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (signal) {
      signal.removeEventListener("abort", onExternalAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-start
// ---------------------------------------------------------------------------

function isValidHealth(h: unknown): h is MeridianHealth {
  return (
    typeof h === "object" &&
    h !== null &&
    "status" in h &&
    typeof (h as MeridianHealth).status === "string"
  );
}

async function isReachable(
  baseUrl: string,
  timeoutMs = HEALTH_TIMEOUT_MS
): Promise<{ ok: boolean; health?: MeridianHealth }> {
  try {
    const health = await fetchHealth(baseUrl, AbortSignal.timeout(timeoutMs));
    return { ok: true, health };
  } catch {
    return { ok: false };
  }
}

let startInFlight: Promise<boolean> | null = null;
let lastStartFailedAt = 0;
const START_RETRY_COOLDOWN_MS = 30_000;
let versionChecked = false;

/**
 * Start Meridian as a detached background process.
 * Returns true if Meridian became reachable after starting.
 * Dedupes concurrent calls and avoids rapid retry loops.
 */
async function startMeridianDaemon(
  baseUrl: string,
  port: number
): Promise<boolean> {
  // Dedupe: if a start is already in flight, wait on it
  if (startInFlight) return startInFlight;

  // Cooldown: don't retry immediately after a failure
  if (Date.now() - lastStartFailedAt < START_RETRY_COOLDOWN_MS) return false;

  startInFlight = (async () => {
    let spawnError: string | null = null;

    try {
      await new Promise<void>((resolveSpawn) => {
        try {
          const child = spawn("meridian", ["--port", String(port)], {
            detached: true,
            stdio: "ignore",
            env: process.env,
          });

          child.unref();

          child.on("error", (err: NodeJS.ErrnoException) => {
            spawnError = err.code === "ENOENT"
              ? "meridian not found on PATH. Install: npm install -g @rynfar/meridian"
              : `Failed to start: ${err.message}`;
            resolveSpawn();
          });

          // Resolve once the process has launched (or errored)
          // The daemon takes a moment to bind the port
          setTimeout(resolveSpawn, 200);
        } catch (err) {
          spawnError = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
          resolveSpawn();
        }
      });

      if (spawnError) {
        lastStartFailedAt = Date.now();
        return false;
      }

      // Poll until reachable or deadline, using bounded timeout per probe
      const deadline = Date.now() + STARTUP_WAIT_MS;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if ((await isReachable(baseUrl, Math.min(HEALTH_TIMEOUT_MS, remaining))).ok) {
          return true;
        }
        await new Promise((r) => setTimeout(r, STARTUP_POLL_MS));
      }

      lastStartFailedAt = Date.now();
      return false;
    } finally {
      startInFlight = null;
    }
  })();

  return startInFlight;
}

// ---------------------------------------------------------------------------
// Version check
// ---------------------------------------------------------------------------

interface VersionStatus {
  installed: string | null;
  latest: string | null;
  updateAvailable: boolean;
}

/**
 * Compare two semver strings.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

async function getInstalledVersion(): Promise<string | null> {
  try {
    // Try the global node_modules via the meridian executable
    const { stdout: whichOutput } = await exec("which meridian", { timeout: 3000 });
    const binPath = whichOutput.trim();
    if (!binPath) return null;

    // Resolve the real path (in case it's a symlink)
    const resolved = realpathSync(binPath);

    // The package.json should be in a parent node_modules directory
    // e.g. /opt/homebrew/lib/node_modules/@rynfar/meridian/package.json
    // or next to the bin in a package directory
    const possiblePaths = [
      // Standard npm global layout: bin -> ../lib/node_modules/@rynfar/meridian/
      join(resolved, "..", "..", "lib", "node_modules", "@rynfar", "meridian", "package.json"),
      // Check the bin's directory for package.json
      join(resolved, "..", "package.json"),
      // Walk up from bin looking for node_modules/@rynfar/meridian
    ];

    for (const pkgPath of possiblePaths) {
      try {
        const content = await readFile(pkgPath, "utf8");
        const pkg: unknown = JSON.parse(content);
        if (
          typeof pkg === "object" && pkg !== null &&
          (pkg as Record<string, unknown>).name === "@rynfar/meridian" &&
          typeof (pkg as Record<string, unknown>).version === "string"
        ) {
          return (pkg as Record<string, unknown>).version as string;
        }
      } catch {
        // Try next candidate path
      }
    }
  } catch {
    // Fallback: can't determine
  }
  return null;
}

async function getLatestVersion(): Promise<string | null> {
  try {
    const { stdout } = await exec("npm view @rynfar/meridian version", {
      timeout: 10000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function checkVersion(): Promise<VersionStatus> {
  const [installed, latest] = await Promise.all([
    getInstalledVersion(),
    getLatestVersion(),
  ]);

  return {
    installed,
    latest,
    updateAvailable:
      installed !== null && latest !== null && compareSemver(installed, latest) < 0,
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const baseUrl = getBaseUrl();
  const port = getPortFromBaseUrl(baseUrl);

  // Register the Meridian provider
  pi.registerProvider("meridian", {
    baseUrl,
    apiKey: "meridian", // Placeholder — Meridian authenticates via Claude Code SDK
    api: "anthropic-messages",
    authHeader: true,
    headers: {
      "x-meridian-agent": "pi",
    },
    models: [
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5 (Meridian)",
        reasoning: true,
        input: DEFAULT_MODEL_INPUT,
        cost: SONNET_COST,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: 64000,
      },
      {
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5 (Meridian)",
        reasoning: true,
        input: DEFAULT_MODEL_INPUT,
        cost: OPUS_COST,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: 64000,
      },
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6 (Meridian)",
        reasoning: true,
        input: DEFAULT_MODEL_INPUT,
        cost: SONNET_COST,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: 64000,
      },
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6 (Meridian)",
        reasoning: true,
        input: DEFAULT_MODEL_INPUT,
        cost: OPUS_COST,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: 32000,
      },
      {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5 (Meridian)",
        reasoning: true,
        input: DEFAULT_MODEL_INPUT,
        cost: HAIKU_COST,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: 8192,
      },
    ],
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "meridian") return;

    if (!event.payload || typeof event.payload !== "object") {
      return event.payload;
    }

    return {
      ...(event.payload as Record<string, unknown>),
      system: buildMeridianSafeSystemPrompt(ctx.getSystemPrompt(), ctx.cwd),
    };
  });

  // Proactive error detection via HTTP status — fires before stream consumption.
  // This catches auth failures, server errors, and rate limits before the
  // user sees a cryptic streaming error.
  pi.on("after_provider_response", (event, ctx) => {
    if (ctx.model?.provider !== "meridian") return;

    if (event.status === 401 || event.status === 403) {
      ctx.ui.notify(
        `Meridian auth error (HTTP ${event.status}). Run /meridian to check login status.`,
        "error"
      );
    } else if (event.status >= 500) {
      ctx.ui.notify(
        `Meridian server error (HTTP ${event.status}). The proxy may be misconfigured or down.`,
        "error"
      );
    } else if (event.status >= 400) {
      ctx.ui.notify(
        `Meridian request error (HTTP ${event.status}).`,
        "warning"
      );
    }
  });

  // Register /meridian command with optional "start" argument
  pi.registerCommand("meridian", {
    description: "Check Meridian status. Use: /meridian start | /meridian version",
    handler: async (args, ctx) => {
      const subcmd = args.trim().toLowerCase();

      // /meridian start — start the daemon if not running
      if (subcmd === "start") {
        const { ok: alreadyRunning, health: runningHealth } = await isReachable(baseUrl);
        if (alreadyRunning && runningHealth) {
          ctx.ui.notify(`Meridian is already running at ${baseUrl}`, "info");
          return;
        }
        ctx.ui.notify(`Starting Meridian on port ${port}...`, "info");
        const started = await startMeridianDaemon(baseUrl, port);
        if (started) {
          const health = await fetchHealth(baseUrl);
          if (health.auth?.loggedIn) {
            ctx.ui.notify(
              `✓ Meridian started (${baseUrl}) — ${health.auth.email} (${health.auth.subscriptionType || "unknown"})`,
              "info"
            );
          } else {
            ctx.ui.notify(
              `✓ Meridian started (${baseUrl}) — not logged in, run: claude login`,
              "warning"
            );
          }
        } else {
          // spawn error details were captured in startMeridianDaemon
          ctx.ui.notify(
            `Failed to start Meridian. Is it installed? (npm install -g @rynfar/meridian)`,
            "error"
          );
        }
        return;
      }

      // /meridian version — check for updates
      if (subcmd === "version" || subcmd === "update") {
        ctx.ui.notify("Checking Meridian version...", "info");
        const [health, version] = await Promise.all([
          fetchHealth(baseUrl).catch((): MeridianHealth => ({ status: "unreachable" })),
          checkVersion(),
        ]);

        const lines: string[] = [];
        if (version.installed) {
          lines.push(`Installed: v${version.installed}`);
        } else {
          lines.push("Installed: unknown (meridian not found on PATH)");
        }
        if (version.latest) {
          lines.push(`Latest:    v${version.latest}`);
        } else {
          lines.push("Latest:    could not check (npm unreachable?)");
        }

        if (version.updateAvailable) {
          lines.push("");
          lines.push(`⚠ Update available: v${version.installed} → v${version.latest}`);
          lines.push("  Run: npm install -g @rynfar/meridian");
        } else if (version.installed && version.latest) {
          lines.push("");
          lines.push("✓ Up to date");
        }

        const running = health.status !== "unreachable";
        lines.push("");
        lines.push(running ? `Running at ${baseUrl}` : `Not running`);

        ctx.ui.notify(lines.join("\n"), version.updateAvailable ? "warning" : "info");
        return;
      }

      // Unknown subcommand
      if (subcmd && subcmd !== "") {
        ctx.ui.notify(
          `Unknown /meridian subcommand: ${subcmd}. Use: /meridian start | /meridian version`,
          "error"
        );
        return;
      }

      // /meridian — health check
      let health: MeridianHealth;
      try {
        health = await fetchHealth(baseUrl, ctx.signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("timed out")) {
          ctx.ui.notify(
            `Meridian health check timed out at ${baseUrl}`,
            "error"
          );
        } else if (err instanceof Error && err.name === "AbortError") {
          return; // User cancelled
        } else {
          ctx.ui.notify(
            `Meridian unreachable at ${baseUrl}. Use /meridian start to launch it.`,
            "error"
          );
        }
        return;
      }

      if (health.status === "healthy" && health.auth?.loggedIn) {
        const lines = [
          `✓ Meridian connected (${baseUrl})`,
          `  Auth: ${health.auth.email} (${health.auth.subscriptionType || "unknown"})`,
          `  Mode: ${health.mode || "unknown"}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      } else if (health.status === "healthy") {
        ctx.ui.notify(
          `Meridian connected but auth issue: ${health.error || "not logged in"}. Run: claude login`,
          "warning"
        );
      } else if (health.status === "degraded") {
        ctx.ui.notify(
          `Meridian degraded: ${health.error || "unknown"}`,
          "warning"
        );
      } else {
        ctx.ui.notify(
          `Meridian unhealthy: ${health.error || health.status}`,
          "error"
        );
      }
    },
  });

  // Auto-start Meridian on session start if provider is active and proxy is down
  pi.on("session_start", async (_event, ctx) => {
    const model = ctx.model;
    if (model?.provider !== "meridian") return;

    try {
      const health = await fetchHealth(baseUrl);
      if (health.status !== "healthy" || !health.auth?.loggedIn) {
        ctx.ui.notify(
          `Meridian issue: ${health.error || health.status}. Run /meridian for details.`,
          "warning"
        );
      }
    } catch {
      // Meridian is unreachable — try auto-starting
      ctx.ui.notify(`Meridian not running. Auto-starting...`, "info");
      const started = await startMeridianDaemon(baseUrl, port);
      if (started) {
        ctx.ui.notify(
          `✓ Meridian auto-started at ${baseUrl}`,
          "info"
        );
      } else {
        ctx.ui.notify(
          `Could not auto-start Meridian. Run manually: meridian`,
          "error"
        );
      }
    }

    // Check for updates once per pi launch
    if (!versionChecked) {
      versionChecked = true;
      const version = await checkVersion();
      if (version.updateAvailable) {
        ctx.ui.notify(
          `⚠ Meridian update available: v${version.installed} → v${version.latest}. Run /meridian version for details.`,
          "warning"
        );
      }
    }
  });
}