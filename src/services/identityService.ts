import * as vscode from "vscode";
import { execFile } from "child_process";
import * as os from "os";
import { BrowserProfileIdentity, AppAccountIdentity } from "../class/InteractionRecord";
import { logger } from "../utils/logger";

function gitUserEmail(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["config", "--get", "user.email"], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function vscodeAuthEmail(): Promise<{ email: string | null; id: string | null }> {
  for (const providerId of ["github", "microsoft"]) {
    try {
      const session = await vscode.authentication.getSession(providerId, ["read:user"], {
        createIfNone: false,
        silent: true,
      });
      if (session?.account) {
        return { email: session.account.label, id: session.account.id };
      }
    } catch (err) {
      logger.warn(`identityService: ${providerId} auth session lookup failed: ${String(err)}`);
    }
  }
  return { email: null, id: null };
}

/** Best-effort identity resolution. Phase 1 has no backend-side auth binding yet. */
export async function resolveIdentity(): Promise<{
  browserProfileIdentity: BrowserProfileIdentity;
  appAccountIdentity: AppAccountIdentity;
}> {
  const authIdentity = await vscodeAuthEmail();
  const gitEmail = authIdentity.email ? null : await gitUserEmail();
  const osUser = os.userInfo().username;

  const resolvedEmail = authIdentity.email ?? gitEmail;
  const candidates = [resolvedEmail, gitEmail].filter((e): e is string => !!e);

  return {
    browserProfileIdentity: {
      email: resolvedEmail,
      id: authIdentity.id ?? osUser,
      source: authIdentity.email ? "vscode.authentication" : gitEmail ? "git_config" : "os_user",
      status: resolvedEmail ? "ok" : "unavailable",
    },
    appAccountIdentity: {
      visible_email_candidates: candidates.length ? candidates : [],
      source: "ide_extension_identity_resolution",
      confidence: candidates.length ? "candidate" : "unknown",
    },
  };
}
