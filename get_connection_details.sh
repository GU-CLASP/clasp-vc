#!/bin/bash

resp=$(curl -sS -X POST "http://127.0.0.1:9000/api/invites" \
  -H "content-type: application/json" \
  -H "x-admin-key: adminkey11LL" \
  -d '{"role":"participant","ttlSeconds":3600,"maxUses":1}')

inviteId=$(echo "$resp" | jq -r .inviteId)
key=$(echo "$resp" | sed -n 's/.*[?&]k=\([^"]*\).*/\1/p')

curl -sS -X POST "http://127.0.0.1:9000/api/connection-details" \
  -H "content-type: application/json" \
  -d "{\"inviteId\":\"$inviteId\",\"key\":\"$key\",\"name\":\"Test\"}" | jq

