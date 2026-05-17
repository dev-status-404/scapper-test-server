import { instagramConfig, requireProxyConfig } from "./instagram.js";

let currentProxyIndex = 0;

/**
 * Get next proxy configuration for a scraping session.
 * Returns structured config object with host, port, username, password.
 */
export const getNextProxyConfig = () => {
  const proxyConfig = requireProxyConfig();
  const port = proxyConfig.ports[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % proxyConfig.ports.length;

  return {
    host: proxyConfig.host,
    port,
    username: proxyConfig.username,
    password: proxyConfig.password,
  };
};

/**
 * Convert proxy config object to URL string for axios/HttpsProxyAgent.
 */
export const proxyConfigToUrl = (config) => {
  if (!config?.host || !config?.port || !config?.username || !config?.password) {
    throw new Error("Proxy configuration is incomplete.");
  }

  const username = encodeURIComponent(config.username);
  const password = encodeURIComponent(config.password);
  return `http://${username}:${password}@${config.host}:${config.port}`;
};

export const getAllProxyUrls = () =>
  instagramConfig.proxy.ports.map((port) =>
    proxyConfigToUrl({
      host: instagramConfig.proxy.host,
      port,
      username: instagramConfig.proxy.username,
      password: instagramConfig.proxy.password,
    }),
  );

/**
 * Get proxy configuration for a specific account with sticky session support.
 */
export const getProxyForAccount = (account) => {
  if (!account) return null;

  if (account.proxyUrl) {
    try {
      const url = new URL(account.proxyUrl);
      return {
        host: url.hostname,
        port: Number.parseInt(url.port, 10),
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
    } catch {
      return getNextProxyConfig();
    }
  }

  return getNextProxyConfig();
};

