# Allowlisted deployment agent

This small service receives an authenticated deployment request from GitHub
Actions and updates one or more Portainer stacks. It deliberately has no Docker
socket and accepts no image name, stack ID, command, or registry username from
the request body.

## Request contract

`POST /deploy` accepts this JSON body:

```json
{
  "project": "degiro-portfolio",
  "repository": "TristanBomans/degiro-portfolio",
  "commit": "<full 40-character Git SHA>"
}
```

The caller signs `<unix timestamp>.<raw JSON body>` with HMAC-SHA256. The
signature, timestamp, and unique delivery ID are sent through the `X-Deploy-*`
headers. `X-Registry-Auth` contains a base64-encoded Docker auth object with the
registry username and short-lived workflow token.

Projects are defined in `targets.json`. Each target pins the repository, image
prefix, registry username, and exact Portainer stack IDs/names. The deployed
image is always derived as `image:sha-<commit>`; it cannot be supplied by the
caller.

## Adding a project

Add another top-level key to `targets.json`, deploy the updated worker, and add
a workflow that signs the same request contract. Keep the HMAC secret in the
repository's Actions secrets and in the worker's `DEPLOY_SHARED_SECRET`
environment variable.
