FROM common

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "await fetch('http://127.0.0.1:3000/health').then(r => { if (!r.ok) throw 1 })"

ENTRYPOINT ["bun", "run", "services/attestation/dist/index.js"]
