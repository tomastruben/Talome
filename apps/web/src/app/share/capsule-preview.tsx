"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Box,
  Check,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";

interface CapsuleInput {
  key: string;
  label: string;
  secret: boolean;
}

interface CapsuleApp {
  appId: string;
  name: string;
  description?: string;
  storeId?: string;
  requiredInputs: CapsuleInput[];
}

interface StackCapsule {
  v: 2;
  id: string;
  name: string;
  description: string;
  author: string;
  tags: string[];
  apps: CapsuleApp[];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function decodeBase64UrlJson(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function capsuleFingerprint(json: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("This browser cannot verify the capsule fingerprint.");
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)));
  let binary = "";
  for (const byte of digest.slice(0, 9)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function decodeCapsule(code: string): Promise<{ capsule: StackCapsule; fingerprint: string }> {
  if (!code.startsWith("t2.")) throw new Error("This is not a Talome stack capsule.");
  if (code.length > 150_000) throw new Error("This capsule is too large to preview safely.");

  const encoded = code.slice(3);
  const separator = encoded.indexOf(".");
  const payload = separator === -1 ? encoded : encoded.slice(0, separator);
  const fingerprint = separator === -1 ? "" : encoded.slice(separator + 1);
  if (!payload || (fingerprint && !/^[A-Za-z0-9_-]{12}$/.test(fingerprint))) {
    throw new Error("This capsule has an invalid fingerprint.");
  }

  const json = decodeBase64UrlJson(payload);
  if (fingerprint && await capsuleFingerprint(json) !== fingerprint) {
    throw new Error("This capsule changed after it was created. Ask the sender for a new copy.");
  }
  const parsed = JSON.parse(json) as Partial<StackCapsule>;

  if (
    parsed.v !== 2 ||
    !isString(parsed.id) ||
    !isString(parsed.name) ||
    !isString(parsed.description) ||
    !isString(parsed.author) ||
    !Array.isArray(parsed.tags) ||
    !parsed.tags.every(isString) ||
    !Array.isArray(parsed.apps) ||
    parsed.apps.length === 0 ||
    !parsed.apps.every((app) =>
      app &&
      isString(app.appId) &&
      isString(app.name) &&
      (app.description === undefined || isString(app.description)) &&
      (app.storeId === undefined || isString(app.storeId)) &&
      Array.isArray(app.requiredInputs) &&
      app.requiredInputs.every((input) =>
        input && isString(input.key) && isString(input.label) && typeof input.secret === "boolean"
      )
    )
  ) {
    throw new Error("This capsule is incomplete or has an unsupported format.");
  }

  return { capsule: parsed as StackCapsule, fingerprint };
}

function inferScheme(address: string): "http" | "https" {
  const host = address.split("/", 1)[0].split(":", 1)[0].toLowerCase();
  const privateIpv4 = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host);
  return privateIpv4 || host === "localhost" || host.endsWith(".local") || !host.includes(".") ? "http" : "https";
}

export function buildTalomeImportUrl(address: string, code: string): string | null {
  const trimmed = address.trim();
  if (!trimmed || !code.startsWith("t2.")) return null;

  try {
    const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `${inferScheme(trimmed)}://${trimmed}`;
    const target = new URL(withScheme);
    if (target.protocol !== "http:" && target.protocol !== "https:") return null;
    if (target.username || target.password) return null;
    target.search = "";
    target.hash = "";
    let basePath = target.pathname === "/" ? "" : target.pathname.replace(/\/+$/, "");
    const talomeRoute = basePath.match(/\/(?:dashboard(?:\/.*)?|login|import)$/);
    if (talomeRoute?.index !== undefined) basePath = basePath.slice(0, talomeRoute.index);
    target.pathname = basePath.endsWith("/import") ? basePath : `${basePath}/import`;
    target.hash = code;
    return target.toString();
  } catch {
    return null;
  }
}

function fileNameFor(capsule: StackCapsule): string {
  const slug = capsule.name.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return `${slug || "talome-stack"}.talome-stack`;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Sandboxed and non-secure browsers may expose the API but deny writes.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is unavailable.");
}

export function CapsulePreview() {
  const [code, setCode] = useState("");
  const [capsule, setCapsule] = useState<StackCapsule | null>(null);
  const [fingerprint, setFingerprint] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [talomeAddress, setTalomeAddress] = useState("");

  useEffect(() => {
    let cancelled = false;

    const readHash = async () => {
      let nextCode = window.location.hash.slice(1).trim();
      try {
        nextCode = decodeURIComponent(nextCode);
      } catch {
        if (cancelled) return;
        setCode("");
        setCapsule(null);
        setFingerprint("");
        setError("This stack link is malformed.");
        return;
      }
      if (cancelled) return;
      setCode(nextCode);
      setCopied(false);

      if (!nextCode) {
        setCapsule(null);
        setFingerprint("");
        setError("This link does not contain a stack capsule.");
        return;
      }

      try {
        const decoded = await decodeCapsule(nextCode);
        if (cancelled) return;
        setCapsule(decoded.capsule);
        setFingerprint(decoded.fingerprint);
        setError("");
      } catch (cause) {
        if (cancelled) return;
        setCapsule(null);
        setFingerprint("");
        setError(cause instanceof Error ? cause.message : "This stack capsule cannot be opened.");
      }
    };

    const onHashChange = () => void readHash();
    void readHash();
    window.addEventListener("hashchange", onHashChange);
    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  const requiredInputCount = useMemo(
    () => capsule?.apps.reduce((total, app) => total + app.requiredInputs.length, 0) ?? 0,
    [capsule],
  );

  const talomeImportUrl = useMemo(
    () => buildTalomeImportUrl(talomeAddress, code),
    [talomeAddress, code],
  );

  async function copyCode() {
    try {
      await copyText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  function downloadCapsule() {
    if (!capsule) return;
    const blob = new Blob([code], { type: "application/vnd.talome.stack;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileNameFor(capsule);
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/50">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <Link href="/" aria-label="Talome home"><Logo /></Link>
          <span className="rounded-full border border-border/70 bg-card/60 px-3 py-1 text-[11px] text-muted-foreground">
            Portable stack preview
          </span>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-12 md:py-20">
        {error || !capsule ? (
          <section className="mx-auto max-w-lg rounded-3xl border border-border bg-card/60 p-8 text-center">
            <div className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
              <AlertTriangle className="size-5" />
            </div>
            <h1 className="mt-5 text-xl font-medium tracking-tight">Stack capsule unavailable</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{error || "This link is incomplete."}</p>
            <Button asChild variant="outline" className="mt-6 rounded-full">
              <Link href="/">Go to Talome</Link>
            </Button>
          </section>
        ) : (
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
            <section>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-primary">
                  <WifiOff className="size-3" /> Sender can be offline
                </span>
                <span>{capsule.apps.length} app{capsule.apps.length === 1 ? "" : "s"}</span>
                <span aria-hidden>·</span>
                <span>{requiredInputCount} setup field{requiredInputCount === 1 ? "" : "s"}</span>
              </div>

              <h1 className="mt-5 max-w-2xl text-3xl font-medium tracking-[-0.035em] md:text-5xl">
                {capsule.name}
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">{capsule.description}</p>
              {(capsule.author || capsule.tags.length > 0) && (
                <div className="mt-5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground/70">
                  {capsule.author && <span>Shared by {capsule.author}</span>}
                  {capsule.tags.map((tag) => (
                    <span key={tag} className="rounded-full bg-muted px-2.5 py-1">{tag}</span>
                  ))}
                </div>
              )}

              <div className="mt-10 space-y-2">
                {capsule.apps.map((app, index) => (
                  <article key={`${app.appId}-${index}`} className="rounded-2xl border border-border/70 bg-card/50 p-4 md:p-5">
                    <div className="flex items-start gap-4">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                        <Box className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h2 className="font-medium">{app.name}</h2>
                          <span className="font-mono text-[10px] text-muted-foreground/55">{app.appId}</span>
                        </div>
                        {app.description && <p className="mt-1 text-sm leading-6 text-muted-foreground">{app.description}</p>}
                        {app.requiredInputs.length > 0 ? (
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {app.requiredInputs.map((input) => (
                              <span key={input.key} className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/40 px-2 py-1 text-[11px] text-muted-foreground">
                                {input.secret && <KeyRound className="size-3" />}
                                {input.label}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-2 text-xs text-muted-foreground/60">No required setup fields declared</p>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <aside className="rounded-3xl border border-border bg-card/70 p-5 lg:sticky lg:top-6">
              <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <ShieldCheck className="size-4" />
              </div>
              <h2 className="mt-4 font-medium">Recreate this stack</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Enter the address of the Talome that should receive it. This page does not contact or test that address—your browser opens it directly.
              </p>
              <label htmlFor="talome-address" className="mt-5 block text-xs font-medium text-foreground">
                Your Talome address
              </label>
              <input
                id="talome-address"
                type="text"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={talomeAddress}
                onChange={(event) => setTalomeAddress(event.target.value)}
                placeholder="http://192.168.1.20:3000"
                className="mt-2 h-10 w-full rounded-xl border border-border bg-background/60 px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/55 focus:border-primary/60"
              />
              <p className="mt-2 text-[11px] leading-4 text-muted-foreground/70">
                LAN, VPN, Tailscale, localhost, and public URLs are accepted. Include http:// or https:// when needed.
              </p>
              <div className="mt-5 grid gap-2">
                {talomeImportUrl ? (
                  <Button asChild className="w-full rounded-xl">
                    <a href={talomeImportUrl}>
                      <ExternalLink className="size-4" /> Open in my Talome
                    </a>
                  </Button>
                ) : (
                  <Button disabled className="w-full rounded-xl">
                    <ExternalLink className="size-4" /> Open in my Talome
                  </Button>
                )}
                <Button onClick={() => void copyCode()} className="w-full rounded-xl">
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  {copied ? "Copied" : "Copy import code"}
                </Button>
                <Button onClick={downloadCapsule} variant="outline" className="w-full rounded-xl">
                  <Download className="size-4" /> Download capsule
                </Button>
              </div>
              <div className="mt-5 border-t border-border/60 pt-5">
                <p className="text-xs leading-5 text-muted-foreground/75">
                  The capsule contains only the app recipe. No server address, Compose YAML, defaults, or secret values are included. The fragment is not sent in the page request.{fingerprint ? ` Verified fingerprint: ${fingerprint}.` : ""}
                </p>
              </div>
              <Link href="/#install" className="mt-5 inline-flex items-center gap-1.5 text-xs text-primary hover:underline">
                Need Talome? Install it <ArrowRight className="size-3" />
              </Link>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}
