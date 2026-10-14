// Rome's Joy admin Worker: a tiny path router. ":name" segments become params, a trailing "*" captures the rest.

function matchSegments(segments, parts) {
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === '*') {
      params.rest = parts.slice(i).join('/');
      return params;
    }
    if (i >= parts.length) return null;
    if (seg.startsWith(':')) {
      try { params[seg.slice(1)] = decodeURIComponent(parts[i]); } catch { return null; }
    } else if (seg !== parts[i]) {
      return null;
    }
  }
  return parts.length === segments.length ? params : null;
}

export function createRouter() {
  const routes = [];
  const api = {
    /** Returns { handler, params }, { methodMismatch: true } when only the method differs, or null. */
    match(method, path) {
      const parts = path.split('/').filter(Boolean);
      let pathMatched = false;
      for (const route of routes) {
        const params = matchSegments(route.segments, parts);
        if (!params) continue;
        pathMatched = true;
        if (route.method === method) return { handler: route.handler, params };
      }
      return pathMatched ? { methodMismatch: true } : null;
    },
  };
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    api[method.toLowerCase()] = (pattern, handler) => {
      routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
      return api;
    };
  }
  return api;
}
