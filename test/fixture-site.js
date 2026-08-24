/** A tiny site used by the tests: links, a redirect, a 404 and a noindex page. */
import http from 'node:http'

const PAGES = {
  '/': `<!doctype html><html lang="en"><head><title>Fixture Home Page For Tests</title>
    <meta name="description" content="The home page of the fixture site used by the crawler tests, long enough to pass the length check.">
    <link rel="canonical" href="/"></head>
    <body><h1>Home</h1><p>${'word '.repeat(200)}</p>
    <a href="/about">About</a><a href="/blog/">Blog</a><a href="/old">Old</a>
    <a href="/missing">Missing</a><a href="/private/secret">Secret</a>
    <a href="https://example.org/external">External</a>
    <a href="mailto:hi@example.com">Mail</a><a href="/style.css">CSS</a></body></html>`,
  '/about': `<!doctype html><html lang="en"><head><title>About This Fixture Website</title></head>
    <body><h1>About</h1><p>${'word '.repeat(200)}</p><a href="/">Home</a><a href="/about/team">Team</a></body></html>`,
  '/about/team': `<!doctype html><html><head><title>Team</title></head><body><p>thin</p><a href="/">Home</a></body></html>`,
  '/blog': `<!doctype html><html lang="en"><head><title>Blog Index Of The Fixture Site</title>
    <meta name="robots" content="noindex"></head><body><h1>Blog</h1><a href="/">Home</a></body></html>`,
  '/orphan': `<!doctype html><html><head><title>Orphan Page Only In Sitemap</title></head><body><h1>Orphan</h1></body></html>`,
  '/private/secret': `<!doctype html><html><head><title>Secret</title></head><body>secret</body></html>`,
}

export function startFixtureSite() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const pathname = url.pathname.replace(/\/+$/, '') || '/'

    if (pathname === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(`User-agent: *\nDisallow: /private\n\nSitemap: http://127.0.0.1:${server.address().port}/sitemap.xml\n`)
      return
    }

    if (pathname === '/sitemap.xml') {
      const base = `http://127.0.0.1:${server.address().port}`
      response.writeHead(200, { 'content-type': 'application/xml' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>${base}/</loc></url><url><loc>${base}/orphan</loc></url></urlset>`)
      return
    }

    if (pathname === '/old') {
      response.writeHead(301, { location: '/about' })
      response.end()
      return
    }

    if (pathname === '/style.css') {
      response.writeHead(200, { 'content-type': 'text/css' })
      response.end('body{color:red}')
      return
    }

    const body = PAGES[pathname]
    if (!body) {
      response.writeHead(404, { 'content-type': 'text/html' })
      response.end('<html><body>Not found</body></html>')
      return
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'last-modified': 'Wed, 01 May 2024 00:00:00 GMT' })
    response.end(body)
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })
    })
  })
}
