// Local fixture traffic must not inherit a developer's outbound proxy.
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_USE_ENV_PROXY"]) {
  delete process.env[name]
}
