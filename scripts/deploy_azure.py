#!/usr/bin/env python3
"""
Deploy the `api/` Azure Functions folder as a zip deployment to an existing Azure Function App.

Usage:
  python scripts/deploy_azure.py --app-name <FUNCTION_APP_NAME> --resource-group <RG> --subscription <SUB_ID>

This script will:
 - create a zip of the `api/` directory (preserving folder structure)
 - upload the zip to the Function App's /api/zipdeploy endpoint using a publishing profile
 - poll the deployment status until success or timeout

Requirements:
 - Python 3.8+
 - `requests` and `azure-identity` and `msrest` libraries (install via pip)
 - An Azure publish profile XML file for the Function App, or an environment variable `AZURE_PUBLISH_PROFILE` containing the XML.

Notes:
 - We avoid GitHub Actions and use the publish profile for reliable zip deployments.
 - If you prefer, obtain the publish profile from the portal: Function App → Get publish profile.
"""

import argparse
import os
import sys
import zipfile
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests


def build_zip(api_dir: Path, out_path: Path):
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(api_dir):
            for f in files:
                full = Path(root) / f
                arc = full.relative_to(api_dir.parent)
                zf.write(full, arc.as_posix())


def parse_publish_profile(xml_text: str):
    # Extract MSDeploy publishUrl, userName, userPWD
    root = ET.fromstring(xml_text)
    for pub in root.findall("publishProfile"):
        if pub.get("publishMethod") == "MSDeploy":
            return {
                "publishUrl": pub.get("publishUrl"),
                "userName": pub.get("userName"),
                "userPWD": pub.get("userPWD"),
            }
    raise RuntimeError("No MSDeploy publishProfile found in profile XML")


def deploy_zip(publish_profile, zip_path: Path, timeout: int = 300):
    # For Function Apps, use Kudu zipdeploy endpoint: https://<sitename>.scm.azurewebsites.net/api/zipdeploy
    publish_url = publish_profile["publishUrl"]
    # publishUrl often looks like 'waws-prod-blu-001.scm.azurewebsites.net:443'
    site = publish_url.split(":")[0]
    kudu_url = f"https://{site}/api/zipdeploy"

    user = publish_profile["userName"]
    pwd = publish_profile["userPWD"]

    with open(zip_path, "rb") as fh:
        print(f"Uploading zip to {kudu_url} ...")
        resp = requests.post(kudu_url, auth=(user, pwd), data=fh)

    if resp.status_code not in (200, 202):
        raise RuntimeError(f"Zip deploy failed: {resp.status_code} {resp.text}")

    # Poll deployment status
    status_url = f"https://{site}/api/deployments/latest"
    start = time.time()
    while time.time() - start < timeout:
        r = requests.get(status_url, auth=(user, pwd))
        if r.status_code == 200:
            j = r.json()
            status = j.get("status")
            if status == 4:
                print("Deployment succeeded")
                return True
            elif status in (3,):
                print("Deployment failed:", j)
                raise RuntimeError("Deployment failed")
        time.sleep(2)
    raise RuntimeError("Deployment status polling timed out")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--publish-profile", help="Path to the publish profile XML. If omitted, reads AZURE_PUBLISH_PROFILE env var")
    p.add_argument("--api-dir", default="api", help="Path to api directory to deploy")
    p.add_argument("--zip-output", help="Path to write temporary zip file")
    p.add_argument("--timeout", type=int, default=300, help="Deployment polling timeout seconds")
    args = p.parse_args()

    api_dir = Path(args.api_dir)
    if not api_dir.exists():
        print(f"api directory not found: {api_dir}")
        sys.exit(2)

    if args.publish_profile:
        pp_text = Path(args.publish_profile).read_text()
    else:
        pp_text = os.environ.get("AZURE_PUBLISH_PROFILE")
        if not pp_text:
            print("Need publish profile: pass --publish-profile or set AZURE_PUBLISH_PROFILE env var with the XML contents")
            sys.exit(2)

    publish_profile = parse_publish_profile(pp_text)

    if args.zip_output:
        zip_path = Path(args.zip_output)
        build_zip(api_dir, zip_path)
    else:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".zip") as tf:
            zip_path = Path(tf.name)
        build_zip(api_dir, zip_path)

    try:
        deploy_zip(publish_profile, zip_path, timeout=args.timeout)
    finally:
        try:
            zip_path.unlink()
        except Exception:
            pass


if __name__ == "__main__":
    main()


