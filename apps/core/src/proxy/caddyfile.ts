/**
 * Pure function: generates a Caddyfile string from proxy route definitions.
 * Supports optional forward-auth for transparent SSO across all proxied apps.
 */

interface ProxyRoute {
  domain: string;
  upstream: string;
  tlsMode: "auto" | "selfsigned" | "manual" | "off";
  enabled: boolean;
  /** App ID — used to check auth bypass rules */
  appId?: string;
}

interface AuthConfig {
  /** Whether forward-auth is enabled globally */
  enabled: boolean;
  /** The internal URL of the Talome auth verify endpoint */
  verifyUrl: string;
  /** App IDs that bypass auth (apps with built-in auth like Vaultwarden) */
  bypassAppIds: string[];
}

export function generateCaddyfile(
  routes: ProxyRoute[],
  acmeEmail?: string,
  auth?: AuthConfig,
): string {
  const lines: string[] = [];

  // Global options block
  lines.push("{");
  if (acmeEmail) {
    lines.push(`  email ${acmeEmail}`);
  }
  lines.push("}");
  lines.push("");

  // Forward-auth snippet — reusable across site blocks
  if (auth?.enabled && auth.verifyUrl) {
    lines.push("(talome_auth) {");
    lines.push(`  forward_auth ${auth.verifyUrl} {`);
    lines.push("    uri /api/auth/verify");
    lines.push("    copy_headers X-Talome-User X-Talome-Role");
    lines.push("  }");
    lines.push("}");
    lines.push("");
  }

  const enabledRoutes = routes.filter((r) => r.enabled);

  for (const route of enabledRoutes) {
    const scheme = route.tlsMode === "off" ? "http://" : "";
    lines.push(`${scheme}${route.domain} {`);

    // TLS configuration
    if (route.tlsMode === "selfsigned") {
      lines.push("  tls internal");
    } else if (route.tlsMode === "off") {
      // No TLS block needed for HTTP-only
    }
    // "auto" uses Caddy's default ACME (Let's Encrypt)

    // Forward-auth — inject unless this app is on the bypass list
    const shouldAuth = auth?.enabled
      && auth.verifyUrl
      && !(route.appId && auth.bypassAppIds.includes(route.appId));
    if (shouldAuth) {
      lines.push("  import talome_auth");
    }

    lines.push(`  reverse_proxy ${route.upstream}`);
    lines.push("}");
    lines.push("");
  }

  return lines.join("\n");
}
