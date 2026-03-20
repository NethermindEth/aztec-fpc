FROM common

COPY services/topup/config.example.yaml services/topup/

HEALTHCHECK --interval=1s --timeout=3s --start-period=30s --retries=5 \
  CMD bun -e "const port=process.env.TOPUP_OPS_PORT || '3001'; const r=await fetch('http://127.0.0.1:'+port+'/ready'); if (!r.ok) throw new Error('not ready')"

VOLUME ["/data"]

ENTRYPOINT ["bun", "run", "services/topup/dist/index.js"]
