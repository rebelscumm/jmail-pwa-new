#!/usr/bin/env bash
set -euo pipefail

# Register production and dev hostnames for an Azure Static Web App using az cli.
# NOTE: Adding hostnames under the azurewebsites.net/scm.azurewebsites.net managed domains
# may not be supported. Use this script only if you control the DNS and the Static Web App
# accepts those hostnames. It requires a logged-in az session (or use Azure/login in GH Actions).

usage() {
  cat <<EOF
Usage: $0 --name <static_app_name> --resource-group <rg> --prod-hostname <prod> --dev-hostname <dev>

Example:
  $0 --name my-static-app --resource-group my-rg --prod-hostname jmail-pwa-new-api.scm.azurewebsites.net \
    --dev-hostname dev.jmail-pwa-new-api.scm.azurewebsites.net

This script runs `az staticwebapp hostname set` for each hostname.
EOF
  exit 2
}

if [[ ${#@} -eq 0 ]]; then
  usage
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) STATIC_NAME="$2"; shift 2;;
    --resource-group) RG="$2"; shift 2;;
    --prod-hostname) PROD_HOST="$2"; shift 2;;
    --dev-hostname) DEV_HOST="$2"; shift 2;;
    -h|--help) usage;;
    *) echo "Unknown arg: $1"; usage;;
  esac
done

if [[ -z "${STATIC_NAME:-}" || -z "${RG:-}" || -z "${PROD_HOST:-}" || -z "${DEV_HOST:-}" ]]; then
  usage
fi

echo "Registering hostnames for Static Web App '${STATIC_NAME}' in resource group '${RG}'"

echo "Registering prod hostname: ${PROD_HOST}"
az staticwebapp hostname set --name "${STATIC_NAME}" --resource-group "${RG}" --hostname "${PROD_HOST}"

echo "Registering dev hostname: ${DEV_HOST}"
az staticwebapp hostname set --name "${STATIC_NAME}" --resource-group "${RG}" --hostname "${DEV_HOST}"

echo "Hostname registration commands completed. You may need to verify DNS TXT records as instructed by Azure." 


