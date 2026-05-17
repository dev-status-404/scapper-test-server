export const t = (message, values = {}) => {
  let translated = String(message ?? "");

  for (const [key, value] of Object.entries(values || {})) {
    translated = translated.replaceAll(`{${key}}`, String(value));
  }

  return translated;
};

export default { t };