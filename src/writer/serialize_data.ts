/** JSON data cannot terminate the surrounding XML-like prompt delimiter. */
export const serializeData = (value: unknown): string =>
  JSON.stringify(value).replaceAll("<", "\\u003c");
