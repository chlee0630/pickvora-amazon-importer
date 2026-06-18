export function withEmbeddedAppContext(path, search) {
  if (!search) return path;

  const contextParams = new URLSearchParams(search);
  if ([...contextParams].length === 0) return path;

  const [pathAndQuery, hash = ""] = path.split("#", 2);
  const queryIndex = pathAndQuery.indexOf("?");
  const pathname = queryIndex >= 0 ? pathAndQuery.slice(0, queryIndex) : pathAndQuery;
  const query = queryIndex >= 0 ? pathAndQuery.slice(queryIndex + 1) : "";
  const targetParams = new URLSearchParams(query);

  for (const [key, value] of contextParams) {
    if (!targetParams.has(key)) {
      targetParams.append(key, value);
    }
  }

  const mergedQuery = targetParams.toString();
  const mergedPath = mergedQuery ? `${pathname}?${mergedQuery}` : pathname;
  return hash ? `${mergedPath}#${hash}` : mergedPath;
}
