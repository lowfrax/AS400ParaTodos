# Núcleo IBM i: sesiones 5250 (WebSocket), trabajos, mandatos CL y ejecución RPG/CL.
FROM node:22-bookworm-slim
WORKDIR /app
COPY shared ./shared
COPY services/ibmi-core/package.json ./services/ibmi-core/
WORKDIR /app/services/ibmi-core
RUN npm install --omit=dev --no-audit --no-fund
COPY services/ibmi-core ./
ENV PORT=5250 NODE_NO_WARNINGS=1
EXPOSE 5250
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://localhost:5250/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
