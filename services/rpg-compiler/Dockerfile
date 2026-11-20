# Compilador ILE RPG / CL / DDS: sin dependencias externas.
FROM node:22-bookworm-slim
WORKDIR /app
COPY shared ./shared
COPY services/rpg-compiler ./services/rpg-compiler
WORKDIR /app/services/rpg-compiler
ENV PORT=5251 NODE_NO_WARNINGS=1
EXPOSE 5251
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://localhost:5251/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
