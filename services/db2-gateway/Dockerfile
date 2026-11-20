# DB2 Gateway: Node.js + driver ibm_db (incluye el IBM Data Server Driver / clidriver).
FROM node:22-bookworm
WORKDIR /app
COPY shared ./shared
COPY services/db2-gateway/package.json ./services/db2-gateway/
WORKDIR /app/services/db2-gateway
# ibm_db descarga el clidriver de IBM durante la instalación (requiere acceso a public.dhe.ibm.com).
RUN npm install --omit=dev --no-audit --no-fund && node -e "require('ibm_db'); console.log('ibm_db OK')"
COPY services/db2-gateway ./
ENV PORT=5252 NODE_NO_WARNINGS=1
EXPOSE 5252
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s CMD node -e "fetch('http://localhost:5252/stats').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
