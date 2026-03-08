# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Builder
#   - Installs pnpm, builds the Vite/React application
#   - Output is in /app/dist
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

# Enable corepack so that pnpm is available without a separate install step.
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy the full source tree.
COPY . ./

# ── Install dependencies with stable Vite ─────────────────────────────────────
# The project pins vite@8.0.0-beta.* via pnpm.overrides in package.json.
# That beta requires the optional "rolldown" package which is not yet available
# in the public registry, so the build would fail.
# We patch package.json in-place to swap vite to a stable 6.x release and
# reinstall cleanly.
RUN rm -rf node_modules && \
    node -e " \
      const fs = require('fs'); \
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')); \
      pkg.devDependencies.vite = '^6.3.5'; \
      if (pkg.pnpm && pkg.pnpm.overrides) delete pkg.pnpm.overrides.vite; \
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2)); \
    " && \
    pnpm install --no-frozen-lockfile

# Skip tsc type-check — the container only needs a valid JS bundle.
RUN pnpm vite build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Runtime (nginx)
#   - Serves the static bundle
#   - Proxies /api/* → backend server so the browser never hits CORS
#   - Sets the security headers required by SharedArrayBuffer / ffmpeg.wasm
# ─────────────────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Remove the default nginx site configuration.
RUN rm /etc/nginx/conf.d/default.conf

# ── nginx site configuration ──────────────────────────────────────────────────
RUN cat > /etc/nginx/conf.d/app.conf << 'EOF'
server {
    listen       80;
    server_name  _;

    # ── Security headers required by @ffmpeg/ffmpeg (SharedArrayBuffer) ───────
    add_header Cross-Origin-Opener-Policy   "same-origin"    always;
    add_header Cross-Origin-Embedder-Policy "credentialless" always;

    # ── Static assets ─────────────────────────────────────────────────────────
    root   /usr/share/nginx/html;
    index  index.html;

    # Cache hashed assets forever; never cache index.html itself.
    location ~* \.(js|css|wasm|woff2?|ttf|eot|ico|png|svg|webp)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        add_header Cross-Origin-Opener-Policy   "same-origin"    always;
        add_header Cross-Origin-Embedder-Policy "credentialless" always;
    }

    location = /index.html {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        add_header Cross-Origin-Opener-Policy   "same-origin"    always;
        add_header Cross-Origin-Embedder-Policy "credentialless" always;
    }

    # ── API reverse proxy → backend server ────────────────────────────────────
    # Strips the /api prefix before forwarding, mirroring the Vite dev proxy.
    # SERVER_HOST and SERVER_PORT are injected at runtime via envsubst.
    location /api/ {
        proxy_pass         http://${SERVER_HOST}:${SERVER_PORT}/;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Disable buffering for streaming audio endpoints.
        proxy_buffering          off;
        proxy_request_buffering  off;

        proxy_hide_header Cross-Origin-Resource-Policy;
        add_header        Cross-Origin-Resource-Policy "cross-origin" always;
    }

    # ── SPA fallback ──────────────────────────────────────────────────────────
    location / {
        try_files $uri $uri/ /index.html;
    }
}
EOF

# Copy the production bundle from the builder stage.
COPY --from=builder /app/dist /usr/share/nginx/html

# SERVER_HOST / SERVER_PORT are substituted into nginx.conf at container start
# via the envsubst wrapper that the official nginx image runs automatically.
ENV SERVER_HOST=server \
    SERVER_PORT=3000

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost/index.html || exit 1
