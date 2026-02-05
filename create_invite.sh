#!/bin/bash

curl -X POST http://127.0.0.1:9000/api/invites \
  -H "x-admin-key: adminkey11LL" \
  -H "Content-Type: application/json" \
  -d '{
    "role": "participant",
    "ttlSeconds": 86400,
    "maxUses": 10
  }'
