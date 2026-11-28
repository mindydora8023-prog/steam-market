FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY package.json ./
COPY app/ ./app/
COPY lib/ ./lib/

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health',{signal:AbortSignal.timeout(3000)}).then(r=>r.ok?r.json():null).then(data=>{if(!data?.ok)process.exitCode=1}).catch(()=>{process.exitCode=1})"]

CMD ["sh", "-c", "if [ -n \"$STEAM_PROXY\" ]; then set -- --proxy \"$STEAM_PROXY\"; fi; exec node app/server.mjs --host 0.0.0.0 --port \"$PORT\" \"$@\""]
