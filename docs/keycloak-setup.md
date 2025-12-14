# Keycloak Setup Guide

This guide covers Keycloak configuration for docs-mcp-server authentication.

## Client Configuration

### Basic Settings

| Setting | Value |
|---------|-------|
| Client ID | `docs-mcp-server` (or your preferred name) |
| Client Protocol | `openid-connect` |
| Access Type | `public` |
| Valid Redirect URIs | `http://localhost:6280/*`, `https://your-domain.com/*` |

### Algorithm Configuration

Configure ES256 for compact JWT tokens (required for cookie-based session storage):

1. Go to Client → Keys
2. Set "Signature Algorithm" to `ES256`

ES256 produces smaller tokens (~300 bytes signature) compared to RS256 (~350 bytes), helping keep total cookie size under 4KB.

## Client Scopes

Remove unnecessary scopes to reduce token size:

### Scopes to Remove

| Scope | Reason |
|-------|--------|
| `profile` | Not needed if only email is required |
| `web-origins` | CORS origins, not needed for server-side auth |
| `acr` | Authentication Context Class Reference, rarely used |
| `microprofile-jwt` | MicroProfile JWT claims, not needed |
| `roles` | Remove if role-based access control is not used |

### Scopes to Keep

| Scope | Purpose |
|-------|---------|
| `openid` | Required for OIDC flow |
| `email` | User email claim |

### How to Remove Scopes

1. Go to Client → Client Scopes tab
2. In "Assigned Default Client Scopes", click the scope to remove
3. Click "Remove" button
4. Repeat for each unnecessary scope

## Token Size Optimization

Target: Keep total session cookie under 4KB (browser limit).

Session cookie contains:
- `accessToken`: JWT token (~1-2KB with ES256)
- `idToken`: JWT token (~500 bytes)
- `refreshToken`: Opaque token (~100 bytes)
- `user`: User info object (~100 bytes)
- `expiresAt`: Timestamp (~13 bytes)

### Additional Optimizations

1. **Reduce Access Token Claims**: Go to Client Scopes → access token → Mappers, disable unused mappers
2. **Shorter Token Lifespan**: Realm Settings → Tokens → Access Token Lifespan (shorter = smaller `exp` claim)
3. **Disable Audience**: If not using audience validation, remove `aud` claim mapper

## Environment Variables

```bash
DOCS_MCP_AUTH_ENABLED=true
DOCS_MCP_AUTH_ISSUER_URL=https://keycloak.example.com/realms/your-realm
DOCS_MCP_AUTH_CLIENT_ID=docs-mcp-server
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `invalid_scope` error | Ensure requested scopes exist in Keycloak client |
| Cookie too large warning | Remove more scopes or mappers |
| Token validation failed | Check issuer URL matches Keycloak realm URL |
