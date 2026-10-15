#!/bin/bash
# usage: api.sh USER METHOD PATH [json]
U=$1; M=$2; P=$3; D=$4
if [ -n "$D" ]; then curl -s -w '\nHTTP %{http_code}\n' -X $M localhost:5005$P -H "x-user: $U" -H 'content-type: application/json' -d "$D"; else curl -s -w '\nHTTP %{http_code}\n' -X $M localhost:5005$P -H "x-user: $U"; fi
