FROM common

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "const port=process.env.TOPUP_OPS_PORT || '3001'; const r=await fetch('http://127.0.0.1:'+port+'/health'); if (!r.ok) throw new Error('unhealthy')"

ENTRYPOINT ["bun", "run", "services/topup/dist/index.js"]
