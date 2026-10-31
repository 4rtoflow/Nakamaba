// CloudFront Functions（JavaScript runtime 2.0）。S3 は /<ページ名>/ を index.html へ読み替えない。
function handler(event) {
  const request = event.request;
  const uri = request.uri;

  if (uri.endsWith('/')) {
    request.uri = `${uri}index.html`;
    return request;
  }

  const lastSegment = uri.slice(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') !== -1) {
    return request;
  }

  // 末尾の / が無いと、ページ内の相対リンクが 1 つ上を指してしまう
  const query = Object.keys(request.querystring)
    .map((name) => {
      const entry = request.querystring[name];
      const values = entry.multiValue ? entry.multiValue : [entry];
      return values.map((item) => (item.value ? `${name}=${item.value}` : name)).join('&');
    })
    .join('&');

  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: { location: { value: `${uri}/${query ? `?${query}` : ''}` } },
  };
}
