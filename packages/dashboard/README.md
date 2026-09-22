# Dashboard development

The dashboard reads `/api/v1/public/overview` by default. API failures display an
error and a refresh button; they never substitute sample usage or cost data.

To preview the fixed sample dataset without an API, explicitly enable demo mode:

```sh
VITE_DEMO_MODE=true pnpm --filter @aiusage/dashboard dev
```

`VITE_DEMO_MODE=true` can also be supplied at build time for a dedicated demo.
Both the dashboard and embedded widgets label these numbers as fixed samples.
Leave this variable unset for normal deployments.
