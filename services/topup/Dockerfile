FROM common

COPY services/topup/config.example.yaml services/topup/

HEALTHCHECK --interval=1s --timeout=3s --start-period=30s --retries=5 \
  CMD entrypoint -e "fetch('http://127.0.0.1:' + (process.env.TOPUP_OPS_PORT || '3001') + '/ready').then(r => { if (!r.ok) throw 1 })"

VOLUME ["/data"]

ENTRYPOINT ["entrypoint", "services/topup/dist/index.js"]
