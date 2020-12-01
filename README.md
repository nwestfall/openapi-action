# OpenAPI Action
Uses 'openapi-core' to generate lint errors/warnings and show as checks in GitHub Actions

https://github.com/Redocly/openapi-cli 

```
- name: OpenAPI Lint Checks
- uses: nwestfall/openapi-action@main
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
```
