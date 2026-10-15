# syntax=docker/dockerfile:1

# webapp-anything publishing server.
#   docker build -t webapp-anything .
#   docker run -p 8080:8080 -v waa-data:/data webapp-anything
# Bake the browser runtimes into the image (~250 MB) so builds never download:
#   docker build --build-arg PREFETCH_RUNTIMES=1 --build-arg WAA_CACHE_DIR=/opt/waa-cache -t webapp-anything .

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ARG PREFETCH_RUNTIMES=0
ARG WAA_CACHE_DIR=/data/cache
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    WAA_DATA_DIR=/data \
    WAA_CACHE_DIR=${WAA_CACHE_DIR} \
    WAA_LOG_FORMAT=json
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY package.json LICENSE README.md ./
COPY assets ./assets
RUN mkdir -p /data "${WAA_CACHE_DIR}" && chown -R node:node /data "${WAA_CACHE_DIR}"
USER node
RUN if [ "$PREFETCH_RUNTIMES" = "1" ]; then node dist/cli.js runtimes fetch; fi
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
