import { randomBytes, createHash, createSign, createDecipheriv } from "node:crypto";
import { getSetting, setSetting } from "./settings.js";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";

/* ── Marketplace Configuration ────────────────────────── */

export interface AudibleMarketplace {
  domain: string;
  apiDomain: string;
  countryCode: string;
  marketPlaceId: string;
  name: string;
}

export const MARKETPLACES: Record<string, AudibleMarketplace> = {
  us: { domain: "amazon.com", apiDomain: "api.audible.com", countryCode: "us", marketPlaceId: "AF2M0KC94RCEA", name: "United States" },
  uk: { domain: "amazon.co.uk", apiDomain: "api.audible.co.uk", countryCode: "uk", marketPlaceId: "A2I9A3Q2GNFNGQ", name: "United Kingdom" },
  de: { domain: "amazon.de", apiDomain: "api.audible.de", countryCode: "de", marketPlaceId: "AN7V1F1VY261K", name: "Germany" },
  fr: { domain: "amazon.fr", apiDomain: "api.audible.fr", countryCode: "fr", marketPlaceId: "A2728XDNODOQ8T", name: "France" },
  au: { domain: "audible.com.au", apiDomain: "api.audible.com.au", countryCode: "au", marketPlaceId: "AN7EY7DTAW63G", name: "Australia" },
  ca: { domain: "amazon.ca", apiDomain: "api.audible.ca", countryCode: "ca", marketPlaceId: "A2CQZ5RBY40XE", name: "Canada" },
  it: { domain: "amazon.it", apiDomain: "api.audible.it", countryCode: "it", marketPlaceId: "A2N7FU2W2BU2ZC", name: "Italy" },
  in: { domain: "amazon.in", apiDomain: "api.audible.in", countryCode: "in", marketPlaceId: "AJO3FBRUE6J4S", name: "India" },
  jp: { domain: "amazon.co.jp", apiDomain: "api.audible.co.jp", countryCode: "jp", marketPlaceId: "A1QAP3MOU4173J", name: "Japan" },
  es: { domain: "amazon.es", apiDomain: "api.audible.es", countryCode: "es", marketPlaceId: "ALMIKO4SZCSAR", name: "Spain" },
  br: { domain: "amazon.com.br", apiDomain: "api.audible.com.br", countryCode: "br", marketPlaceId: "A10J1VAYUDTYRN", name: "Brazil" },
};

const DEVICE_TYPE_ID = "A2CZJZGLK2JJVM";
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

/* ── Auth Session (in-memory, short-lived) ────────────── */

export interface AudibleAuthSession {
  codeVerifier: string;
  serial: string;
  marketplace: string;
  createdAt: number;
}

const pendingSessions = new Map<string, AudibleAuthSession>();

/** Prune expired sessions */
function cleanupSessions(): void {
  const now = Date.now();
  for (const [id, session] of pendingSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      pendingSessions.delete(id);
    }
  }
}

/* ── Stored Tokens ────────────────────────────────────── */

export interface AudibleTokens {
  accessToken: string;
  refreshToken: string;
  adpToken: string;
  devicePrivateKey: string;
  marketplace: string;
  customerId?: string;
}

const SETTINGS_KEYS = {
  accessToken: "audible_access_token",
  refreshToken: "audible_refresh_token",
  adpToken: "audible_adp_token",
  devicePrivateKey: "audible_device_key",
  marketplace: "audible_marketplace",
  customerId: "audible_customer_id",
  deviceSerial: "audible_device_serial",
} as const;

/* ── Helpers ──────────────────────────────────────────── */

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

function generateSerial(): string {
  // Match Python audible library: uuid4().hex.upper() — 32 uppercase hex chars
  return randomBytes(16).toString("hex").toUpperCase();
}

function buildClientId(serial: string): string {
  const raw = Buffer.from(`${serial}#${DEVICE_TYPE_ID}`, "utf-8");
  return raw.toString("hex");
}

/* ── Public API ───────────────────────────────────────── */

export function getMarketplaces(): Record<string, AudibleMarketplace> {
  return MARKETPLACES;
}

/**
 * Build the Amazon OAuth URL for Audible device registration.
 * Amazon validates return_to — it must be their own maplanding URL.
 * After login, the user copies the maplanding URL and pastes it back.
 */
export function buildOAuthUrl(
  marketplace: string,
): { url: string; sessionId: string } {
  cleanupSessions();

  const mp = MARKETPLACES[marketplace];
  if (!mp) throw new Error(`Unknown marketplace: ${marketplace}`);

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const serial = generateSerial();
  const clientId = buildClientId(serial);
  const sessionId = randomBytes(16).toString("hex");

  pendingSessions.set(sessionId, {
    codeVerifier,
    serial,
    marketplace,
    createdAt: Date.now(),
  });

  // return_to MUST be Amazon's maplanding — custom URLs are rejected
  const returnTo = `https://www.${mp.domain}/ap/maplanding`;

  // Exact parameter set from Python audible library's build_oauth_url
  // Key: openid.ns.oa2 MUST be Amazon's custom namespace, not the standard one
  const params = new URLSearchParams({
    "openid.oa2.response_type": "code",
    "openid.oa2.code_challenge_method": "S256",
    "openid.oa2.code_challenge": codeChallenge,
    "openid.return_to": returnTo,
    "openid.assoc_handle": `amzn_audible_ios_${mp.countryCode}`,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    pageId: "amzn_audible_ios",
    accountStatusPolicy: "P1",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.mode": "checkid_setup",
    "openid.ns.oa2": "http://www.amazon.com/ap/ext/oauth/2",
    "openid.oa2.client_id": `device:${clientId}`,
    "openid.ns.pape": "http://specs.openid.net/extensions/pape/1.0",
    marketPlaceId: mp.marketPlaceId,
    "openid.oa2.scope": "device_auth_access",
    forceMobileLayout: "true",
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.pape.max_auth_age": "0",
  });

  const url = `https://www.${mp.domain}/ap/signin?${params.toString()}`;
  return { url, sessionId };
}

/**
 * Complete the OAuth flow by exchanging the authorization code for tokens
 * via Amazon device registration.
 */
export async function completeRegistration(
  sessionId: string,
  authorizationCode: string,
): Promise<AudibleTokens> {
  cleanupSessions();

  const session = pendingSessions.get(sessionId);
  if (!session) throw new Error("Auth session expired or not found");

  const mp = MARKETPLACES[session.marketplace];
  if (!mp) throw new Error(`Unknown marketplace: ${session.marketplace}`);

  const clientId = buildClientId(session.serial);

  const body = {
    requested_token_type: [
      "bearer",
      "mac_dms",
      "website_cookies",
      "store_authentication_cookie",
    ],
    cookies: {
      website_cookies: [],
      domain: `.${mp.domain}`,
    },
    registration_data: {
      domain: "Device",
      app_version: "3.56.2",
      device_serial: session.serial,
      device_type: DEVICE_TYPE_ID,
      device_name: "%FIRST_NAME%%FIRST_NAME_POSSESSIVE_STRING%%DUPE_STRATEGY_1ST%Audible for iPhone",
      os_version: "15.0.0",
      software_version: "35602678",
      device_model: "iPhone",
      app_name: "Audible",
    },
    auth_data: {
      client_id: clientId,
      authorization_code: authorizationCode,
      code_verifier: session.codeVerifier,
      code_algorithm: "SHA-256",
      client_domain: "DeviceLegacy",
    },
    requested_extensions: ["device_info", "customer_info"],
  };

  const res = await fetch(`https://api.${mp.domain}/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Device registration failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  // Extract tokens from the registration response
  const response = data?.response?.success ?? data?.response;
  if (!response) throw new Error("Unexpected registration response structure");

  const tokens = response.tokens ?? {};

  const bearerToken = tokens.bearer ?? {};
  const macDms = tokens.mac_dms ?? {};
  const extensions = response.extensions ?? {};
  const customerInfo = extensions.customer_info ?? {};

  // Log the full response structure for debugging customer_id extraction


  const accessToken = bearerToken.access_token;
  const refreshToken = bearerToken.refresh_token;
  const adpToken = macDms.adp_token;
  const devicePrivateKey = macDms.device_private_key;

  if (!accessToken || !refreshToken) {
    throw new Error("Registration succeeded but tokens are missing from response");
  }

  if (!adpToken || !devicePrivateKey) {
    throw new Error("Registration succeeded but device signing credentials are missing");
  }

  const result: AudibleTokens = {
    accessToken,
    refreshToken,
    adpToken,
    devicePrivateKey,
    marketplace: session.marketplace,
    customerId: customerInfo.customer_id ?? customerInfo.user_id ?? customerInfo.directed_id ?? undefined,
  };

  // Persist tokens, serial, and clean up session
  storeTokens(result);
  setSetting(SETTINGS_KEYS.deviceSerial, session.serial);
  pendingSessions.delete(sessionId);

  return result;
}

/**
 * Read stored Audible tokens from settings.
 */
export function getStoredTokens(): AudibleTokens | null {
  const accessToken = getSetting(SETTINGS_KEYS.accessToken);
  const refreshToken = getSetting(SETTINGS_KEYS.refreshToken);
  const adpToken = getSetting(SETTINGS_KEYS.adpToken);
  const devicePrivateKey = getSetting(SETTINGS_KEYS.devicePrivateKey);
  const marketplace = getSetting(SETTINGS_KEYS.marketplace);

  if (!accessToken || !refreshToken || !adpToken || !devicePrivateKey || !marketplace) {
    return null;
  }

  return {
    accessToken,
    refreshToken,
    adpToken,
    devicePrivateKey,
    marketplace,
    customerId: getSetting(SETTINGS_KEYS.customerId),
  };
}

/**
 * Persist Audible tokens to settings (secrets are auto-encrypted).
 */
export function storeTokens(tokens: AudibleTokens): void {
  setSetting(SETTINGS_KEYS.accessToken, tokens.accessToken);
  setSetting(SETTINGS_KEYS.refreshToken, tokens.refreshToken);
  setSetting(SETTINGS_KEYS.adpToken, tokens.adpToken);
  setSetting(SETTINGS_KEYS.devicePrivateKey, tokens.devicePrivateKey);
  setSetting(SETTINGS_KEYS.marketplace, tokens.marketplace);
  if (tokens.customerId) {
    setSetting(SETTINGS_KEYS.customerId, tokens.customerId);
  }
}

/**
 * Remove all stored Audible tokens.
 */
export function clearTokens(): void {
  for (const key of Object.values(SETTINGS_KEYS)) {
    db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
  }
}

/**
 * Sign an Audible API request using the device's ADP token and RSA private key.
 * Returns the headers that must be included in the request.
 */
export function signRequest(
  method: string,
  path: string,
  body: string,
  tokens: AudibleTokens,
): Record<string, string> {
  const date = new Date().toISOString();

  const signingString = `${method}\n${path}\n${date}\n${body}\n${tokens.adpToken}`;

  const sign = createSign("RSA-SHA256");
  sign.update(signingString);
  const signature = sign.sign(tokens.devicePrivateKey, "base64");

  return {
    "x-adp-token": tokens.adpToken,
    "x-adp-alg": "SHA256withRSA:1.0",
    "x-adp-signature": `${signature}:${date}`,
  };
}

/**
 * Refresh an expired access token using the refresh token.
 * Access tokens are valid for 60 minutes.
 */
async function refreshAccessToken(tokens: AudibleTokens): Promise<string> {
  const mp = MARKETPLACES[tokens.marketplace];
  if (!mp) throw new Error(`Unknown marketplace: ${tokens.marketplace}`);

  const res = await fetch(`https://api.${mp.domain}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_name: "Audible",
      app_version: "3.56.2",
      source_token: tokens.refreshToken,
      requested_token_type: "access_token",
      source_token_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const newAccessToken = data.access_token as string;
  if (!newAccessToken) throw new Error("No access_token in refresh response");

  // Persist the new access token
  setSetting(SETTINGS_KEYS.accessToken, newAccessToken);
  return newAccessToken;
}

/**
 * Make an authenticated, signed request to the Audible API.
 * Automatically refreshes the access token if it gets a 401.
 */
export async function audibleApiFetch(
  path: string,
  tokens: AudibleTokens,
  params?: Record<string, string>,
): Promise<unknown> {
  const mp = MARKETPLACES[tokens.marketplace];
  if (!mp) throw new Error(`Unknown marketplace: ${tokens.marketplace}`);

  let fullPath = path;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(params).toString();
    fullPath = `${path}?${qs}`;
  }

  async function doFetch(accessToken: string): Promise<Response> {
    const currentTokens = { ...tokens, accessToken };
    const signedHeaders = signRequest("GET", fullPath, "", currentTokens);

    return fetch(`https://${mp.apiDomain}${fullPath}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...signedHeaders,
      },
      signal: AbortSignal.timeout(15000),
    });
  }

  let res = await doFetch(tokens.accessToken);

  // If 401, refresh the token and retry once
  if (res.status === 401) {
    console.log("[audible] Access token expired, refreshing...");
    const newToken = await refreshAccessToken(tokens);
    res = await doFetch(newToken);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Audible API ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * Make an authenticated, signed POST request to the Audible API.
 * Automatically refreshes the access token if it gets a 401.
 */
export async function audibleApiPost(
  path: string,
  tokens: AudibleTokens,
  body: unknown,
): Promise<unknown> {
  const mp = MARKETPLACES[tokens.marketplace];
  if (!mp) throw new Error(`Unknown marketplace: ${tokens.marketplace}`);

  const bodyStr = JSON.stringify(body);

  async function doFetch(accessToken: string): Promise<Response> {
    const currentTokens = { ...tokens, accessToken };
    const signedHeaders = signRequest("POST", path, bodyStr, currentTokens);

    return fetch(`https://${mp.apiDomain}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...signedHeaders,
      },
      body: bodyStr,
      signal: AbortSignal.timeout(30000),
    });
  }

  let res = await doFetch(tokens.accessToken);

  // If 401, refresh the token and retry once
  if (res.status === 401) {
    console.log("[audible] Access token expired on POST, refreshing...");
    const newToken = await refreshAccessToken(tokens);
    res = await doFetch(newToken);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Audible API POST ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * Request a content license for an audiobook ASIN.
 * Returns the download URL and the key/IV needed for FFmpeg decryption.
 *
 * Legal note: Talome never performs cryptographic operations on content.
 * The key and IV are runtime values passed as FFmpeg CLI arguments —
 * the user's own FFmpeg binary handles AES decryption.
 */
export async function requestContentLicense(
  asin: string,
  tokens: AudibleTokens,
): Promise<{ contentUrl: string; key: string; iv: string }> {
  const data = await audibleApiPost(
    `/1.0/content/${asin}/licenserequest`,
    tokens,
    {
      drm_type: "Adrm",
      consumption_type: "Download",
      quality: "High",
    },
  ) as Record<string, unknown>;

  // Navigate the response structure
  const contentLicense = data.content_license as Record<string, unknown> | undefined;
  if (!contentLicense) {
    throw new Error("No content_license in license response");
  }

  const contentMetadata = contentLicense.content_metadata as Record<string, unknown> | undefined;
  const contentUrlObj = contentMetadata?.content_url as Record<string, unknown> | undefined;
  const contentUrl = contentUrlObj?.offline_url as string | undefined;

  if (!contentUrl) {
    throw new Error("No download URL in license response");
  }

  // license_response is a base64-encoded ENCRYPTED voucher.
  // It must be decrypted using a key derived from device credentials.
  const licenseResponse = contentLicense.license_response as string | undefined;
  if (!licenseResponse) {
    throw new Error("No license_response in content license");
  }

  // Derive the voucher decryption key from device metadata
  // Key = SHA256(device_type + serial + customer_id + asin)[0:16]
  // IV  = SHA256(device_type + serial + customer_id + asin)[16:32]
  const serial = getSetting("audible_device_serial");
  const customerId = tokens.customerId;
  if (!serial) throw new Error("Device serial not found — re-authenticate with Audible");
  if (!customerId) throw new Error("Customer ID not found — re-authenticate with Audible");

  const voucherKeyBuf = createHash("sha256")
    .update(`${DEVICE_TYPE_ID}${serial}${customerId}${asin}`, "ascii")
    .digest();
  const voucherKey = voucherKeyBuf.subarray(0, 16);
  const voucherIv = voucherKeyBuf.subarray(16, 32);

  // Decrypt the voucher METADATA envelope (NOT the audiobook content).
  // This extracts the per-book key/IV from a JSON wrapper — same operation
  // performed by audible-cli and Libation. The actual audio content
  // decryption is performed by the user's own FFmpeg binary.
  const encryptedVoucher = Buffer.from(licenseResponse, "base64");
  const decipher = createDecipheriv("aes-128-cbc", voucherKey, voucherIv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encryptedVoucher), decipher.final()]);
  const plaintext = decrypted.toString("utf-8").replace(/\0+$/, ""); // strip trailing nulls

  // Extract the content key and IV from the decrypted JSON
  // Format: {"key":"<hex>","iv":"<hex>",...}
  let key: string;
  let iv: string;

  try {
    const parsed = JSON.parse(plaintext);
    key = parsed.key;
    iv = parsed.iv;
  } catch {
    // Fallback: regex extraction if JSON parse fails
    const match = plaintext.match(/^\{"key":"(?<key>.*?)","iv":"(?<iv>.*?)"/);
    if (!match?.groups?.key || !match?.groups?.iv) {
      throw new Error("Could not extract key/IV from decrypted voucher");
    }
    key = match.groups.key;
    iv = match.groups.iv;
  }

  if (!key || !iv) {
    throw new Error("Decrypted voucher missing key or IV");
  }

  return { contentUrl, key, iv };
}
