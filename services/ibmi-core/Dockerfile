# Núcleo IBM i: sesiones 5250 (web y TN5250), trabajos, mandatos CL, ejecución RPG/CL y todos los servidores TCP/IP
# (TELNET, FTP, REXEC, SSH, HTTP/IWS/XMLSERVICE, Mapepire, servidores host, ISO 8583, SNMP, NTP, LPD).
FROM node:22-bookworm-slim
# openssl genera la CA y el certificado del sistema (TLS de TELNET, FTPS, HTTPS, Mapepire y servidores host)
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY shared ./shared
COPY services/ibmi-core/package.json ./services/ibmi-core/
WORKDIR /app/services/ibmi-core
RUN npm install --omit=dev --no-audit --no-fund
COPY services/ibmi-core ./
ENV PORT=5250 NODE_NO_WARNINGS=1 IFS_ROOT=/ifs
VOLUME ["/ifs"]
EXPOSE 5250 23 992 21 990 512 22 10010 10443 8076 8583 449 8470-8476 9470-9476 515 161/udp 123/udp
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://localhost:5250/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
