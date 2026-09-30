import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveClaudeBinary } from "../ai/claude-binary.js";

const execute = promisify(execFile);
type AuthProbe = () => Promise<{ stdout: string }>;

/** Scaffold execution uses subscription auth; checking it must not spend API credits. */
export async function checkCreatorCliReadiness(probe: AuthProbe = async () => {
  const { ANTHROPIC_API_KEY: _apiKey, CLAUDECODE: _session, ...env } = process.env;
  return execute(resolveClaudeBinary(), ["auth", "status", "--json"], {
    env, timeout: 8_000, maxBuffer: 64 * 1024, encoding: "utf8",
  });
}): Promise<{ ready: true } | { ready: false; error: string }> {
  try {
    const status = JSON.parse((await probe().catch((error: unknown) => {
      // Exit 1 can carry a valid negative status; never accept a positive status
      // from a failed command or expose its stderr to the user.
      const result = error as { code?: unknown; stdout?: unknown };
      if (result.code === 1 && typeof result.stdout === "string" && JSON.parse(result.stdout).loggedIn === false) return { stdout: result.stdout };
      throw error;
    })).stdout) as { loggedIn?: boolean; authMethod?: string };
    if (status.loggedIn === true && status.authMethod !== "api_key") return { ready: true };
    return { ready: false, error: "Scaffold generation is unavailable: Claude Code subscription login is not active. The generated blueprint remains available. This request has not started scaffold execution or published an app." };
  } catch {
    return { ready: false, error: "Scaffold generation is unavailable: Claude Code is missing or its login status could not be verified. The generated blueprint remains available. This request has not started scaffold execution or published an app." };
  }
}
