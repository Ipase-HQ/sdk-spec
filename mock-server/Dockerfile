# Build from the sdk-spec root so the image carries schema/, fixtures/ and VERSION:
#   docker build -f mock-server/Dockerfile -t sdk-spec-mock-server .
FROM node:22-alpine AS build
WORKDIR /app/mock-server
COPY mock-server/package.json mock-server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY mock-server/tsconfig.json mock-server/tsconfig.build.json ./
COPY mock-server/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
WORKDIR /app
COPY schema ./schema
COPY fixtures ./fixtures
COPY VERSION ./VERSION
COPY mock-server/package.json ./mock-server/package.json
COPY --from=build /app/mock-server/node_modules ./mock-server/node_modules
COPY --from=build /app/mock-server/dist ./mock-server/dist
EXPOSE 8787
HEALTHCHECK --interval=5s --timeout=2s --retries=5 CMD wget -qO- http://127.0.0.1:8787/__health || exit 1
USER node
CMD ["node", "mock-server/dist/cli.js"]
