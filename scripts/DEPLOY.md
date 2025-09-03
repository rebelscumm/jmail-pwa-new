# Deploying the `api/` Azure Functions with a local Python script

This repository includes `scripts/deploy_azure.py` — a small helper to create a zip of `api/` and deploy it to an existing Azure Function App using the app's publish profile.

Steps:

1. Obtain the Function App publish profile XML from the Azure Portal (Function App → Get publish profile). Save it locally or copy its contents to the `AZURE_PUBLISH_PROFILE` environment variable.

2. Install requirements:

```bash
python -m pip install requests
```

3. Run the script:

```bash
python scripts/deploy_azure.py --publish-profile path/to/your/publishprofile.PublishSettings
```

Or via env var:

```bash
export AZURE_PUBLISH_PROFILE="$(cat path/to/publishprofile.PublishSettings)"
python scripts/deploy_azure.py
```

The script uploads a zip to the Function App's kudu zipdeploy endpoint and polls until the deployment finishes.

If you prefer using an automated CI later, keep the publish profile secret safe; it can be stored in the CI's secret store.


