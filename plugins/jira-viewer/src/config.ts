// Settings and their resolution into a connection config.
import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Normalise what a user types for the site into an origin.
 * Accepts `acme`, `acme.atlassian.net`, `https://acme.atlassian.net/jira/...`.
 * Returns null when it cannot be a Jira Cloud site.
 */
export function normalizeSite(input: string): string | null {
  const value = input.trim();
  if (value === "") return null;
  const withHost = /^[a-z0-9-]+$/i.test(value) ? `${value}.atlassian.net` : value;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(withHost)
    ? withHost
    : `https://${withHost}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname.includes(".")) return null;
  return url.origin;
}

/**
 * Normalise the developer API base URL override. Plain http is allowed only
 * for loopback so a token is never sent in the clear to another machine.
 */
export function normalizeBaseUrlOverride(input: string): string | null {
  const value = input.trim();
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
    return url.origin;
  }
  return null;
}

export const settingDescriptors = {
  site: {
    type: "string",
    label: "Jira site",
    description:
      "Your Jira Cloud site, such as acme.atlassian.net.",
    default: "",
    experimental_schema: z
      .string()
      .refine(
        (value) => value.trim() === "" || normalizeSite(value) !== null,
        "Enter a Jira Cloud site such as acme.atlassian.net (https only)",
      ),
  },
  email: {
    type: "string",
    label: "Account email",
    description: "The email of the Atlassian account the API token belongs to.",
    default: "",
    experimental_schema: z
      .string()
      .refine(
        (value) => value.trim() === "" || /^[^\s@]+@[^\s@]+$/.test(value.trim()),
        "Enter an email address",
      ),
  },
  apiToken: {
    type: "string",
    label: "API token",
    description:
      "Create one at id.atlassian.com → Security → API tokens. Stored as a secret on the server.",
    secret: true,
  },
  apiBaseUrl: {
    type: "string",
    label: "Developer: API base URL override",
    description:
      "Leave empty. For development against a mock server, such as http://127.0.0.1:4010. Plain http is allowed only for localhost.",
    default: "",
    experimental_schema: z
      .string()
      .refine(
        (value) => value.trim() === "" || normalizeBaseUrlOverride(value) !== null,
        "Use https, or http on localhost / 127.0.0.1",
      ),
  },
} as const;

export interface SettingValues {
  site: string;
  email: string;
  apiToken?: string | number | boolean | undefined;
  apiBaseUrl: string;
}

export type MissingSetting = "site" | "email" | "apiToken";

export interface ResolvedConfig {
  /** Where REST calls go: the override when set, else the site. */
  apiBaseUrl: string | null;
  /** Where browse links point. */
  siteUrl: string | null;
  email: string | null;
  token: string | null;
  usingOverride: boolean;
  missing: MissingSetting[];
}

export interface ReadyConfig extends ResolvedConfig {
  apiBaseUrl: string;
  siteUrl: string;
  email: string;
  token: string;
}

export function resolveConfig(values: SettingValues): ResolvedConfig {
  const siteUrl = normalizeSite(values.site ?? "");
  const override = normalizeBaseUrlOverride(values.apiBaseUrl ?? "");
  const email = (values.email ?? "").trim() || null;
  const token =
    typeof values.apiToken === "string" && values.apiToken.trim() !== ""
      ? values.apiToken.trim()
      : null;
  const missing: MissingSetting[] = [];
  // With only an override (mock development) browse links use the override.
  if (!siteUrl && !override) missing.push("site");
  if (!email) missing.push("email");
  if (!token) missing.push("apiToken");
  return {
    apiBaseUrl: override ?? siteUrl,
    siteUrl: siteUrl ?? override,
    email,
    token,
    usingOverride: override !== null,
    missing,
  };
}

export function isReady(config: ResolvedConfig): config is ReadyConfig {
  return config.missing.length === 0;
}

/** Identity of the account + site, so a change can drop cached data. */
export function connectionIdentity(config: ResolvedConfig): string {
  return `${config.apiBaseUrl ?? ""}|${config.siteUrl ?? ""}|${config.email ?? ""}`;
}
