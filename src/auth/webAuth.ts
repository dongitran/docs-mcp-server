/**
 * Web Authentication middleware for Keycloak OAuth2/OIDC.
 *
 * Provides browser-based authentication flow with:
 * - OAuth2 Authorization Code flow with PKCE (SHA-256)
 * - Stateless cookie-based session storage (multi-pod K8s safe)
 * - HttpOnly + SameSite=Lax cookies for security
 * - Open redirect protection
 * - JWT validation via JWKS
 *
 * Session storage: Tokens are stored directly in HttpOnly cookie as base64-encoded JSON.
 * Requires Keycloak to use ES256 algorithm for compact token size (<4KB total).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { logger } from "../utils/logger";
import type { AuthConfig } from "./types";

// Session cookie name
const SESSION_COOKIE_NAME = "docs_mcp_sid";
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24; // 24 hours in seconds

// PKCE code verifier storage (in-memory, expires after 10 minutes)
// Note: For multi-pod deployment, consider using Redis or storing in cookie
const pkceStore = new Map<string, { codeVerifier: string; expiresAt: number }>();

/**
 * Web authentication context stored in cookie
 */
export interface WebAuthSession {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  user?: {
    sub: string;
    email?: string;
    name?: string;
    preferred_username?: string;
  };
}

/**
 * Generate a random string for PKCE code verifier
 */
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate PKCE code challenge from verifier (SHA-256)
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Generate a random state parameter
 */
function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Get the external base URL from request, respecting X-Forwarded-* headers from reverse proxy.
 * Falls back to HTTPS if host contains a domain (non-localhost).
 */
function getExternalBaseUrl(request: FastifyRequest): string {
  const forwardedProto = request.headers["x-forwarded-proto"] as string | undefined;
  const forwardedHost = request.headers["x-forwarded-host"] as string | undefined;

  const host = forwardedHost || request.headers.host || "localhost";

  // Determine protocol: use forwarded header, or default to https for non-localhost
  let protocol = forwardedProto || request.protocol;
  if (!forwardedProto && !host.startsWith("localhost") && !host.startsWith("127.0.0.1")) {
    protocol = "https";
  }

  return `${protocol}://${host}`;
}

/**
 * Parse cookies from header string into key-value pairs.
 */
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};

  return cookieHeader.split(";").reduce(
    (acc, cookie) => {
      const trimmed = cookie.trim();
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex);
        const value = trimmed.substring(eqIndex + 1);
        if (key && value) {
          acc[key] = value;
        }
      }
      return acc;
    },
    {} as Record<string, string>,
  );
}

/**
 * Get session cookie value from cookie header.
 */
function getSessionCookieValue(cookieHeader: string | undefined): string | null {
  const cookies = parseCookies(cookieHeader);
  return cookies[SESSION_COOKIE_NAME] || null;
}

/**
 * Parse session from cookie (stateless, base64-encoded JSON).
 */
function parseSessionCookie(cookieHeader: string | undefined): WebAuthSession | null {
  const cookieValue = getSessionCookieValue(cookieHeader);
  if (!cookieValue) return null;

  try {
    const decoded = Buffer.from(cookieValue, "base64").toString("utf-8");
    const session = JSON.parse(decoded) as WebAuthSession;

    // Check if session is expired
    if (session.expiresAt < Date.now()) {
      logger.debug("Session cookie expired");
      return null;
    }

    logger.debug(
      `Session parsed for user: ${session.user?.email || session.user?.sub || "unknown"}`,
    );
    return session;
  } catch (error) {
    logger.debug(`Failed to parse session cookie: ${error}`);
    return null;
  }
}

/**
 * Create session cookie with base64-encoded session data.
 * Stores tokens directly in cookie for stateless multi-pod deployment.
 */
function createSessionCookie(session: WebAuthSession): string {
  const sessionJson = JSON.stringify(session);
  const sessionBase64 = Buffer.from(sessionJson).toString("base64");

  const cookieSize = SESSION_COOKIE_NAME.length + 1 + sessionBase64.length;
  logger.debug(`Session cookie size: ${cookieSize} bytes`);

  if (cookieSize > 4000) {
    logger.warn(
      `⚠️ Session cookie size (${cookieSize} bytes) exceeds 4KB limit. Consider reducing token claims in Keycloak.`,
    );
  }

  // HttpOnly: prevents XSS access to cookie
  // SameSite=Lax: CSRF protection while allowing top-level navigation
  // Path=/: cookie available for all routes
  return `${SESSION_COOKIE_NAME}=${sessionBase64}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}`;
}

/**
 * Create logout cookie (expires immediately)
 */
function createLogoutCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Web Authentication Manager for browser-based OAuth2 flow
 */
export class WebAuthManager {
  private discoveredEndpoints: {
    authorizationUrl: string;
    tokenUrl: string;
    userinfoUrl?: string;
    endSessionUrl?: string;
    jwksUri?: string;
  } | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private config: AuthConfig) {}

  /**
   * Initialize the web auth manager by discovering OIDC endpoints
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      logger.debug("Web authentication disabled");
      return;
    }

    if (!this.config.issuerUrl) {
      throw new Error("Issuer URL is required when auth is enabled");
    }

    try {
      logger.info("🔐 Initializing Web OAuth2 authentication...");
      this.discoveredEndpoints = await this.discoverEndpoints();

      if (this.discoveredEndpoints.jwksUri) {
        this.jwks = createRemoteJWKSet(new URL(this.discoveredEndpoints.jwksUri));
      }

      logger.info("✅ Web OAuth2 authentication initialized");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(`❌ Failed to initialize Web OAuth2: ${message}`);
      throw error;
    }
  }

  /**
   * Discover OAuth2/OIDC endpoints from well-known configuration
   */
  private async discoverEndpoints() {
    const oidcUrl = `${this.config.issuerUrl}/.well-known/openid-configuration`;

    const response = await fetch(oidcUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch OIDC configuration from ${oidcUrl}`);
    }

    const config = await response.json();
    return {
      authorizationUrl: config.authorization_endpoint as string,
      tokenUrl: config.token_endpoint as string,
      userinfoUrl: config.userinfo_endpoint as string | undefined,
      endSessionUrl: config.end_session_endpoint as string | undefined,
      jwksUri: config.jwks_uri as string | undefined,
    };
  }

  /**
   * Get authorization URL for login redirect with PKCE
   */
  async getAuthorizationUrl(redirectUri: string, state: string): Promise<string> {
    if (!this.discoveredEndpoints) {
      throw new Error("Web auth manager not initialized");
    }

    // Generate PKCE code verifier and challenge
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Extract state value (before colon) for PKCE storage
    const stateKey = state.split(":")[0];

    // Store code verifier with state key (expires in 10 minutes)
    pkceStore.set(stateKey, {
      codeVerifier,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    logger.debug(`PKCE stored for stateKey: "${stateKey}"`);

    // Cleanup expired entries
    for (const [key, value] of pkceStore.entries()) {
      if (value.expiresAt < Date.now()) {
        pkceStore.delete(key);
      }
    }

    const params = new URLSearchParams({
      client_id: this.config.clientId || this.config.audience || "docs-mcp-server",
      response_type: "code",
      scope: "openid email",
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    return `${this.discoveredEndpoints.authorizationUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(
    code: string,
    redirectUri: string,
    state: string,
  ): Promise<WebAuthSession> {
    if (!this.discoveredEndpoints) {
      throw new Error("Web auth manager not initialized");
    }

    // Get PKCE code verifier
    logger.debug(`PKCE lookup for state: "${state}"`);
    const pkceData = pkceStore.get(state);
    if (!pkceData) {
      logger.warn(
        `⚠️ PKCE not found for state: "${state}". This may be a duplicate callback request.`,
      );
      throw new Error("Invalid or expired state parameter");
    }
    pkceStore.delete(state);

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.config.clientId || this.config.audience || "docs-mcp-server",
      code,
      redirect_uri: redirectUri,
      code_verifier: pkceData.codeVerifier,
    });

    const response = await fetch(this.discoveredEndpoints.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    const tokens = await response.json();

    // Decode ID token to get user info
    let user: WebAuthSession["user"];
    if (tokens.id_token && this.jwks) {
      try {
        const { payload } = await jwtVerify(tokens.id_token, this.jwks, {
          issuer: this.config.issuerUrl,
        });
        user = {
          sub: payload.sub as string,
          email: payload.email as string | undefined,
          name: payload.name as string | undefined,
          preferred_username: payload.preferred_username as string | undefined,
        };
      } catch (error) {
        logger.debug(`Failed to verify ID token: ${error}`);
      }
    }

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      user,
    };
  }

  /**
   * Get logout URL for Keycloak end session
   */
  getLogoutUrl(redirectUri: string, idToken?: string): string | null {
    if (!this.discoveredEndpoints?.endSessionUrl) {
      return null;
    }

    const params = new URLSearchParams({
      post_logout_redirect_uri: redirectUri,
    });

    if (idToken) {
      params.set("id_token_hint", idToken);
    }

    return `${this.discoveredEndpoints.endSessionUrl}?${params.toString()}`;
  }

  /**
   * Validate session by checking expiry and optionally verifying JWT
   */
  async validateSession(session: WebAuthSession): Promise<boolean> {
    // Check if session is expired
    if (session.expiresAt < Date.now()) {
      return false;
    }

    // Validate access token with JWKS if available
    if (this.jwks) {
      try {
        await jwtVerify(session.accessToken, this.jwks, {
          issuer: this.config.issuerUrl,
        });
        return true;
      } catch {
        return false;
      }
    }

    return true;
  }
}

/**
 * Create web authentication middleware for protected routes
 */
export function createWebAuthMiddleware(authManager: WebAuthManager, config: AuthConfig) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.enabled) {
      return; // Auth disabled, allow all
    }

    // Skip auth for auth routes
    if (
      request.url.startsWith("/auth/") ||
      request.url.startsWith("/oauth/") ||
      request.url.startsWith("/.well-known/")
    ) {
      return;
    }

    // Skip auth for static assets
    if (
      request.url.startsWith("/assets/") ||
      request.url.endsWith(".css") ||
      request.url.endsWith(".js") ||
      request.url.endsWith(".ico") ||
      request.url.endsWith(".png") ||
      request.url.endsWith(".svg")
    ) {
      return;
    }

    logger.debug(`Auth middleware for ${request.url}`);

    const session = parseSessionCookie(request.headers.cookie);

    if (!session) {
      logger.debug("No session found, redirecting to login");
      const loginUrl = `/auth/login?redirect=${encodeURIComponent(request.url)}`;
      return reply.redirect(loginUrl);
    }

    // Validate session
    const isValid = await authManager.validateSession(session);
    if (!isValid) {
      logger.debug("Session invalid, redirecting to login");
      reply.header("Set-Cookie", createLogoutCookie());
      const loginUrl = `/auth/login?redirect=${encodeURIComponent(request.url)}`;
      return reply.redirect(loginUrl);
    }

    // Attach user info to request
    (request as FastifyRequest & { user?: WebAuthSession["user"] }).user = session.user;
  };
}

/**
 * Register authentication routes (/auth/login, /auth/callback, /auth/logout, /auth/me)
 */
export function registerAuthRoutes(
  server: FastifyInstance,
  authManager: WebAuthManager,
  config: AuthConfig,
) {
  if (!config.enabled) {
    return;
  }

  // Login route - redirects to Keycloak
  server.get("/auth/login", async (request, reply) => {
    const query = request.query as { redirect?: string };
    let redirectAfterLogin = query.redirect || "/";

    // Validate redirect URL to prevent open redirect attacks
    if (!redirectAfterLogin.startsWith("/") || redirectAfterLogin.startsWith("//")) {
      redirectAfterLogin = "/";
    }

    const baseUrl = getExternalBaseUrl(request);
    const callbackUrl = `${baseUrl}/auth/callback`;
    const state = `${generateState()}:${Buffer.from(redirectAfterLogin).toString("base64")}`;

    const authUrl = await authManager.getAuthorizationUrl(callbackUrl, state);
    return reply.redirect(authUrl);
  });

  // Callback route - handles OAuth2 callback from Keycloak
  server.get("/auth/callback", async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };

    logger.debug(`Auth callback received: code=${query.code?.substring(0, 10)}...`);

    if (query.error) {
      logger.warn(`⚠️ Auth callback error from provider: ${query.error}`);
      return reply.status(400).send(`Authentication error: ${query.error}`);
    }

    if (!query.code || !query.state) {
      logger.warn("⚠️ Auth callback missing code or state");
      return reply.status(400).send("Missing code or state parameter");
    }

    try {
      const baseUrl = getExternalBaseUrl(request);
      const callbackUrl = `${baseUrl}/auth/callback`;

      // Extract redirect URL from state
      const [stateValue, redirectBase64] = query.state.split(":");
      let redirectUrl = redirectBase64
        ? Buffer.from(redirectBase64, "base64").toString("utf-8")
        : "/";

      // Validate redirect URL to prevent open redirect attacks
      if (!redirectUrl.startsWith("/") || redirectUrl.startsWith("//")) {
        redirectUrl = "/";
      }

      logger.debug(`Exchanging code for tokens, stateValue: ${stateValue}`);

      // Exchange code for tokens
      const session = await authManager.exchangeCode(query.code, callbackUrl, stateValue);

      logger.info(
        `✅ User authenticated: ${session.user?.email || session.user?.sub || "unknown"}`,
      );

      // Set session cookie and redirect
      const cookie = createSessionCookie(session);
      reply.header("Set-Cookie", cookie);
      return reply.redirect(redirectUrl);
    } catch (error) {
      logger.error(`❌ Auth callback error: ${error}`);
      return reply.status(500).send("Authentication failed");
    }
  });

  // Logout route - clears session and redirects to Keycloak logout
  server.get("/auth/logout", async (request, reply) => {
    const session = parseSessionCookie(request.headers.cookie);
    const baseUrl = getExternalBaseUrl(request);

    // Clear session cookie
    reply.header("Set-Cookie", createLogoutCookie());

    // Redirect to Keycloak logout if available
    const logoutUrl = authManager.getLogoutUrl(baseUrl, session?.idToken);
    if (logoutUrl) {
      return reply.redirect(logoutUrl);
    }

    return reply.redirect("/");
  });

  // User info endpoint (for frontend)
  server.get("/auth/me", async (request, reply) => {
    const session = parseSessionCookie(request.headers.cookie);

    if (!session) {
      return reply.status(401).send({ error: "Not authenticated" });
    }

    return reply.send({
      authenticated: true,
      user: session.user,
    });
  });

  logger.debug("Web authentication routes registered");
}

export { parseSessionCookie, createSessionCookie, createLogoutCookie };
