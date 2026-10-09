import { readFileSync } from "node:fs";
import { Agent } from "node:https";

export function localOrigin(request) {
  try {
    const origin = new URL(`http://${request.headers.host}`);
    return ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ? origin.origin : null;
  } catch { return null; }
}
export function validOrigin(request, required = false) {
  const expected = localOrigin(request);
  return !!expected && (request.headers.origin ? request.headers.origin === expected : !required);
}
export function localSessionCookie(cookie) {
  return cookie.startsWith("sucanvas_session=") ? cookie.replace(/;\s*Secure\b/gi, "") : cookie;
}
export function webDevOriginGuard() {
  return {
    name: "sucanvas-web-dev-origin",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (/^\/(api|v1)(\/|$)/.test(request.url ?? "")) {
          const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET");
          if (!validOrigin(request, mutation)) {
            response.statusCode = 403;
            response.end("Development API requires the configured page origin");
            return;
          }
        }
        next();
      });
    },
  };
}
export function createWebDevProxy(backend, caFile = "") {
  const target = new URL(backend);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
    throw new Error("SUCANVAS_WEB_BACKEND must be an HTTP(S) origin");
  }
  const agent = target.protocol === "https:" ? new Agent({
    rejectUnauthorized: true,
    ...(caFile ? { ca: readFileSync(caFile) } : {}),
  }) : undefined;
  const options = {
    target: target.origin,
    changeOrigin: true,
    secure: true,
    agent,
    ws: true,
    cookieDomainRewrite: "",
    // Generations and event streams may stay open for a long time.
    proxyTimeout: 0,
    timeout: 0,
    configure(proxy) {
      const origin = (outgoing, request) => {
        if (request.headers.origin && validOrigin(request)) outgoing.setHeader("origin", target.origin);
      };
      proxy.on("proxyReq", origin);
      proxy.on("proxyReqWs", (outgoing, request, socket) => {
        if (!validOrigin(request, true)) {
          outgoing.destroy();
          socket.destroy();
          return;
        }
        origin(outgoing, request);
      });
      proxy.on("proxyRes", (response, request) => {
        // Remote HTTPS keeps its Secure cookie. Only the loopback development
        // response adapts that cookie for this local HTTP page.
        const cookies = response.headers["set-cookie"];
        if (cookies && localOrigin(request) && !request.socket.encrypted) {
          response.headers["set-cookie"] = cookies.map(localSessionCookie);
        }
      });
    },
  };
  return { "/api": options, "/v1": { ...options } };
}
